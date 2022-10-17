import { ethers } from "hardhat";
import hre from 'hardhat';
import * as fs from 'fs';
const { BigNumber } = require("ethers");
const fetch = require('node-fetch');
const networkName = hre.network.name;
let addresses;
let DATABASE;
if (networkName == 'testnet') {
    addresses = require('./testnetConfig.json');
    DATABASE = require(`./testnetdatabase.json`);
}else{
    addresses = require('./espaceConfig.json');
    DATABASE = require(`./espacedatabase.json`);
}
let SwappiRouterJSON = require(`./abis/SwappiRouter.sol/SwappiRouter.json`);
let SwappiRouterAddr = addresses.SwappiRouter;
let uipoolJSON = require(`./abis/UiPoolDataProvider.sol/UiPoolDataProvider.json`);
let uipoolAddr = addresses.UiPoolDataProvider;
let LendingPoolJSON = require(`./abis/LendingPool.sol/LendingPool.json`);
let LendingPoolAddr = addresses.LendingPool;
let LiquidateLoanJSON = require(`../artifacts/contracts/LiquidateLoan.sol/LiquidateLoan.json`);
let LiquidateLoanAddr = addresses.LiquidateLoanAddr;
const allowedLiquidation = 50 //50% of a borrowed asset can be liquidated
const healthFactorMax = BigNumber.from('1000000000000000000'); //liquidation can happen when less than 1
// const healthFactorMax = BigNumber.from('2000000000000000000'); //liquidation can happen when less than 1
export var profit_threshold = BigNumber.from('100000000000000000') //.1 * (10**18) //in eth. A bonus below this will be ignored
const GAS_FEE_ESTIMATE = BigInt(1000000000*2000000);
const FLASH_LOAN_FEE = 0.009;
const CHECKPERIOD = 3600000; // 3600 sec
type User = {
    status: string;
    message: string;
    result: [
        {
          "blockNumber": string,
          "timeStamp": string,
          "hash": string,
          "nonce": string,
          "blockHash": string,
          "transactionIndex": string,
          "from": string,
          "to": string,
          "value": string,
          "gas": string,
          "gasPrice": string,
          "isError": string,
          "txreceipt_status": string,
          "input": string,
          "contractAddress": string,
          "cumulativeGasUsed": string,
          "gasUsed": string,
          "confirmations": string
        }
      ]
}

async function request<TResponse>(
    url: string, 
    config: RequestInit = {}
  ): Promise<TReponse> {
    try {
        const response = await fetch(url, config);
        return await response.json();
      }
      catch (error) {
        // Handle the error.
      }
  }
async function parseUsers(uipoolContract, LendingPoolContract, poolDataUIPool){
    var loans=[];
    console.log(`The length of accounts to be processed ${DATABASE.accountsCaptured.length}`);
    for (const entry of DATABASE.accountsCaptured) {
        // console.log(`Processing account ${entry}...`);
        var max_borrowedSymbol;
        var max_borrowedID;
        var max_borrowedPrincipal=BigNumber.from(0);
        var max_borrowedPriceInEth = BigNumber.from(0);
        var max_collateralSymbol;
        var max_collateralID;
        var max_collateralBonus = BigNumber.from(0);
        var max_collateralPriceInEth = BigNumber.from(0);
        var max_collateralInEth = BigNumber.from(0);
        var userDatalp = await LendingPoolContract.getUserAccountData(entry);
        if (userDatalp.healthFactor.lt(healthFactorMax)) {
            var userDataUIPool = await uipoolContract.getUserReservesData(addresses.LendingPoolAddressesProvider, entry);
            userDataUIPool[0].forEach((reserve, i) => {
                var priceInEth= poolDataUIPool[0][i].priceInEth;
                var principalBorrowed = reserve.scaledVariableDebt.add(reserve.principalStableDebt);
                var collateralInEth = reserve.scaledATokenBalance.mul(priceInEth).div(BigNumber.from(10).pow(BigNumber.from(poolDataUIPool[0][i].decimals)));
                if (principalBorrowed.gte(max_borrowedPrincipal)) {
                    max_borrowedSymbol = poolDataUIPool[0][i].symbol
                    max_borrowedID = i;
                    max_borrowedPrincipal = principalBorrowed
                    max_borrowedPriceInEth = priceInEth
                }
                if (reserve.usageAsCollateralEnabledOnUser == true && reserve.scaledATokenBalance.gt(BigNumber.from(0)) /*&& poolDataUIPool[0][i].reserveLiquidationBonus.gt(max_collateralBonus)*/ && collateralInEth.gt(max_collateralInEth)){
                    max_collateralSymbol = poolDataUIPool[0][i].symbol
                    max_collateralID = i;
                    max_collateralBonus = poolDataUIPool[0][i].reserveLiquidationBonus
                    max_collateralPriceInEth = priceInEth
                    max_collateralInEth = collateralInEth
                }
            });
                loans.push( {
                    "user_id"  :  entry,
                    "healthFactor"   :  userDatalp.healthFactor,
                    "max_collateralSymbol" : max_collateralSymbol,
                    "max_collateralID" : max_collateralID,
                    "max_borrowedSymbol" : max_borrowedSymbol,
                    "max_borrowedID" : max_borrowedID,
                    "max_borrowedPrincipal" : max_borrowedPrincipal,
                    "max_borrowedPriceInEth" : max_borrowedPriceInEth,
                    "max_collateralBonus" : max_collateralBonus,
                    "max_collateralPriceInEth" : max_collateralPriceInEth,
                    "max_collateralInEth" : max_collateralInEth
                });
        }
    }
    loans = loans.filter(loan => loan.max_borrowedPrincipal .mul(allowedLiquidation).div(100) .mul (loan.max_collateralBonus.sub(10000)).div(10000).mul(loan.max_borrowedPriceInEth).div(BigNumber.from(10).pow(BigNumber.from(poolDataUIPool[0][loan.max_borrowedID].decimals))) >= profit_threshold);
    // //remove duplicates
    // loans = [...new Map(loans.map((m) => [m.user_id, m])).values()];
    return loans;
}
async function liquidationProfits(loans, poolDataUIPool, SwappiRouterContract, LiquidateLoanContract, deployer){
    for (var loan of loans) {
        await liquidationProfit(loan, poolDataUIPool, SwappiRouterContract, LiquidateLoanContract, deployer);
    }
}
async function liquidationProfit(loan, poolDataUIPool, SwappiRouterContract, LiquidateLoanContract, deployer){
    //flash loan fee
    const flashLoanAmount = percentBigInt(BigInt(loan.max_borrowedPrincipal), allowedLiquidation/100);
    const flashLoanCost = percentBigInt(flashLoanAmount, FLASH_LOAN_FEE);
  //minimum amount of liquidated coins that will be paid out as profit
  var flashLoanAmountInEth = flashLoanAmount * BigInt(loan.max_borrowedPriceInEth) / BigInt(10 ** poolDataUIPool[0][loan.max_borrowedID].decimals);
  var flashLoanAmountInEth_plusBonus = percentBigInt(flashLoanAmountInEth,loan.max_collateralBonus.toNumber()/10000); //add the bonus
  var collateralTokensFromPayout  = flashLoanAmountInEth_plusBonus * BigInt(10 ** poolDataUIPool[0][loan.max_collateralID].decimals) / BigInt(loan.max_collateralPriceInEth); //this is the amount of tokens that will be received as payment for liquidation and then will need to be swapped back to token of the flashloan
  let [bestPath, bestAmtOut] = await fakeSwap(poolDataUIPool[0][loan.max_collateralID].underlyingAsset, collateralTokensFromPayout, poolDataUIPool[0][loan.max_borrowedID].underlyingAsset,SwappiRouterContract);
  // console.log("best path:", bestPath, "amount in", collateralTokensFromPayout, "max Amount out", bestAmtOut);
  var minimumTokensAfterSwap = bestAmtOut;
  var gasFee = GAS_FEE_ESTIMATE; //calc gas fee
  var flashLoanPlusCost = (flashLoanCost + flashLoanAmount);
  var profitInBorrowCurrency = minimumTokensAfterSwap - flashLoanPlusCost;
  var profitInEth = profitInBorrowCurrency * BigInt(loan.max_borrowedPriceInEth) / BigInt(10 ** poolDataUIPool[0][loan.max_borrowedID].decimals);
  var profitInEthAfterGas = (profitInEth)  - gasFee;
  if (profitInEthAfterGas>0.1)
  {
    console.log("-------------------------------")
    console.log(`user_ID:${loan.user_id}`)
    console.log(`HealthFactor ${loan.healthFactor}`)
    console.log(`flashLoanAmount ${flashLoanAmount} ${loan.max_borrowedSymbol}`)
    console.log(`flashLoanAmount converted to USD ${flashLoanAmountInEth}`)
    console.log(`flashLoanAmount converted to USD plus bonus ${flashLoanAmountInEth_plusBonus}`)
    console.log(`payout in collateral Tokens ${collateralTokensFromPayout} ${loan.max_collateralSymbol}`)
    console.log(`${loan.max_borrowedSymbol} received from swap ${minimumTokensAfterSwap} ${loan.max_borrowedSymbol}`)
    console.log("best path:", bestPath);
    console.log(`flashLoanPlusCost ${flashLoanPlusCost}`)
    console.log(`gasFee ${gasFee}`)
    console.log(`profitInEthAfterGas ${Number(profitInEthAfterGas)/(10 ** 18)} USD`)
    let tx = await LiquidateLoanContract.executeFlashLoans(
        poolDataUIPool[0][loan.max_borrowedID].underlyingAsset,
        flashLoanAmount,
        poolDataUIPool[0][loan.max_collateralID].underlyingAsset,
        loan.user_id,
        minimumTokensAfterSwap,
        bestPath
      );
    console.log(">> LiquidateLoanContract executeFlashLoans, hash:", tx.hash);
    await tx.wait();
    console.log(">> ✅ Done");
  }else{
    console.log("----------------NOT CONSIDERED---------------")
    console.log(`user_ID:${loan.user_id}`)
    console.log(`HealthFactor ${loan.healthFactor}`)
    console.log(`flashLoanAmount ${flashLoanAmount} ${loan.max_borrowedSymbol}`)
    console.log(`flashLoanAmount converted to USD ${flashLoanAmountInEth}`)
    console.log(`flashLoanAmount converted to USD plus bonus ${flashLoanAmountInEth_plusBonus}`)
    console.log(`payout in collateral Tokens ${collateralTokensFromPayout} ${loan.max_collateralSymbol}`)
    console.log(`${loan.max_borrowedSymbol} received from swap ${minimumTokensAfterSwap} ${loan.max_borrowedSymbol}`)
    console.log("best path:", bestPath);
    console.log(`flashLoanPlusCost ${flashLoanPlusCost}`)
    console.log(`gasFee ${gasFee}`)
    console.log(`profitInEthAfterGas ${Number(profitInEthAfterGas)/(10 ** 18)} USD`)
  }
}
async function fakeSwap(inAddr, amtIn, outAddr, SwappiRouterContract){
    if (inAddr.toLowerCase() === outAddr.toLowerCase()) {
        return [[], amtIn];
    }
    let tokeList = [];
    for (var val of addresses.SwappiSwapTokens) {
        if (val.toLowerCase() !== inAddr.toLowerCase() && val.toLowerCase() !== outAddr.toLowerCase()) {
            tokeList.push(val);
        }
    }
    // Auxiliary space to store each path
    let paths = new Array();
    paths = allPaths(tokeList);
    // console.log("all paths:", paths);
    return await findBestTrade(inAddr, amtIn, outAddr, SwappiRouterContract, paths);
}
async function findBestTrade(inAddr, amtIn, outAddr, SwappiRouterContract, paths){
    let bestPath = [];
    let amtOut = BigInt(0);
    let bestAmtOut = 0;
    for (var val of paths) {
        val.unshift(inAddr);
        val.push(outAddr);
        amtOut = await SwappiRouterContract.getAmountsOut(amtIn, val);
        if (bestAmtOut <= amtOut[amtOut.length-1].toBigInt()) {
            bestPath = val;
            bestAmtOut = amtOut[amtOut.length-1].toBigInt();
            // console.log("current best path:", bestPath, "amount out", bestAmtOut);
        }
    }
    return [bestPath, bestAmtOut];
}
function allPaths(tokeList) {
    let paths = [];
    let tempPath = new Array();
    printSubsequences(tokeList, 0, tempPath, paths);
    let returnedPaths = [];
    for (var val of paths) {
        if (val.length == 1) {
            returnedPaths.push(val);
        }else{
            returnedPaths = returnedPaths.concat(permutations(val));
        }
    }
    returnedPaths.push([]);
    return returnedPaths;
}
// Recursive function to print all
// possible subsequences for given array
function printSubsequences(arr, index, path, returnedPaths)
{

  // Print the subsequence when reach
  // the leaf of recursion tree
  if (index == arr.length)
  {
   
    // Condition to avoid printing
    // empty subsequence
    if (path.length > 0) {let newPath = [...path]; returnedPaths.push(newPath);};
  }
  else
  {
   
    // Subsequence without including
    // the element at current index
    printSubsequences(arr, index + 1, path, returnedPaths);
 
    path.push(arr[index]);
 
    // Subsequence including the element
    // at current index
    printSubsequences(arr, index + 1, path, returnedPaths);
 
    // Backtrack to remove the recently
    // inserted element
    path.pop();
  }
  return;
}
const permutations = arr => {
    if (arr.length <= 2) return arr.length === 2 ? [arr, [arr[1], arr[0]]] : arr;
    return arr.reduce(
      (acc, item, i) =>
        acc.concat(
          permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(val => [
            item,
            ...val,
          ])
        ),
      []
    );
  };
function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}; 
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("The account:", deployer.address);
    console.log("Account balance before:", (await deployer.getBalance()).toString());
    let LiquidateLoanContract = new ethers.Contract(LiquidateLoanAddr, LiquidateLoanJSON.abi, deployer);
    let SwappiRouterContract = new ethers.Contract(SwappiRouterAddr, SwappiRouterJSON.abi, deployer);
    let uipoolContract = new ethers.Contract(uipoolAddr, uipoolJSON.abi, deployer);
    let LendingPoolContract = new ethers.Contract(LendingPoolAddr, LendingPoolJSON.abi, deployer);
    let poolDataUIPool = await uipoolContract.getSimpleReservesData(addresses.LendingPoolAddressesProvider);
    var currentblockNum = await ethers.provider.getBlockNumber();
    var scanUrl;
    var scanUrlForGW;
    if (networkName == 'testnet') {
        scanUrl = `https://evmapi-testnet.confluxscan.net/api?module=account&action=txlist&address=${addresses.LendingPool}&startblock=${DATABASE.lastblock}`;
        scanUrlForGW = `https://evmapi-testnet.confluxscan.net/api?module=account&action=txlist&address=${addresses.WETHGateway}&startblock=${DATABASE.lastblock}`;
    }else{
        scanUrl = `https://evmapi.confluxscan.net/api?module=account&action=txlist&address=${addresses.LendingPool}&startblock=${DATABASE.lastblock}`;
        scanUrlForGW = `https://evmapi.confluxscan.net/api?module=account&action=txlist&address=${addresses.WETHGateway}&startblock=${DATABASE.lastblock}`;
    }
    while (1) {
        let i = 1;
        let dataPerPage = await request<User>(scanUrl+`&page=${i}&sort=desc`);
        while (dataPerPage.result.length > 0) {
            for (const entry of dataPerPage.result) {
                if (DATABASE.accountsCaptured.includes(entry.from) == false) {
                    DATABASE.accountsCaptured.push(entry.from);
                }
            }
            i = i + 1;
            dataPerPage = await request<User>(scanUrl+`&page=${i}&sort=desc`);
        }
        i = 1;
        let dataForGWPerPage = await request<User>(scanUrlForGW+`&page=${i}&sort=desc`);
        while (dataForGWPerPage.result.length > 0) {
            for (const entry of dataForGWPerPage.result) {
                if (DATABASE.accountsCaptured.includes(entry.from) == false) {
                    DATABASE.accountsCaptured.push(entry.from);
                }
            }
            i = i + 1;
            dataForGWPerPage = await request<User>(scanUrlForGW+`&page=${i}&sort=desc`);
        }
        // console.log(data.result);
        let loans = await parseUsers(uipoolContract, LendingPoolContract, poolDataUIPool);
        console.log("loans:", loans);
        //store into file
        DATABASE.lastblock = currentblockNum + 1;
        let writeableDATABASE = JSON.stringify(DATABASE, null, 2);
        fs.writeFileSync(`./scripts/${networkName}database.json`, writeableDATABASE);
        await liquidationProfits(loans, poolDataUIPool, SwappiRouterContract, LiquidateLoanContract, deployer);
        console.log(`Wait ${CHECKPERIOD/1000} secs`);
        await delay(CHECKPERIOD);
    }
}
// percent is represented as a number less than 0 ie .75 is equivalent to 75%
// multiply base and percent and return a BigInt
function percentBigInt(base:BigInt,percent:decimal):BigInt {
    return BigInt(base * BigInt(percent * 10000) / 10000n)
}

main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error);
    process.exit(1);
});