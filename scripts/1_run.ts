import { ethers } from "hardhat";
import hre from 'hardhat';
const { BigNumber } = require("ethers");
const fetch = require('node-fetch');
const networkName = hre.network.name;
let addresses;
if (networkName == 'testnet') {
    addresses = require('./testnetConfig.json');
}else{
    addresses = require('./espaceConfig.json');
}
let SwappiRouterJSON = require(`./abis/SwappiRouter.sol/SwappiRouter.json`);
let SwappiRouterAddr = addresses.SwappiRouter;
let uipoolJSON = require(`./abis/UiPoolDataProvider.sol/UiPoolDataProvider.json`);
let uipoolAddr = addresses.UiPoolDataProvider;
let LendingPoolJSON = require(`./abis/LendingPool.sol/LendingPool.json`);
let LendingPoolAddr = addresses.LendingPool;
let LiquidateLoanJSON = require(`../artifacts/contracts/LiquidateLoan.sol/LiquidateLoan.json`);
let LiquidateLoanAddr = "0xd89e850E11b9c0A8041A3a58Ab71687e70dd056c";
const allowedLiquidation = 50 //50% of a borrowed asset can be liquidated
// const healthFactorMax = BigNumber.from('1000000000000000000'); //liquidation can happen when less than 1
const healthFactorMax = BigNumber.from('2000000000000000000'); //liquidation can happen when less than 1
export var profit_threshold = BigNumber.from('100000000000000000') //.1 * (10**18) //in eth. A bonus below this will be ignored
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
async function readDataFromUser(user, uipoolContract, LendingPoolContract, poolDataUIPool){
    let userDataUIPool = await uipoolContract.getUserReservesData(addresses.LendingPoolAddressesProvider, user);
    let userDatalp = await LendingPoolContract.getUserAccountData(user);
    console.log('==============begin============');
    console.log(userDataUIPool);
    console.log(userDatalp);
    console.log('==============end============');
}
async function parseUsers(rawData, uipoolContract, LendingPoolContract){
    var loans=[];
    let poolDataUIPool = await uipoolContract.getSimpleReservesData(addresses.LendingPoolAddressesProvider);
    // console.log(poolDataUIPool);
    for (const entry of rawData.result) {
        var max_borrowedSymbol;
        var max_borrowedID;
        var max_borrowedPrincipal=BigNumber.from(0);
        var max_borrowedPriceInEth = BigNumber.from(0);
        var max_collateralSymbol;
        var max_collateralID;
        var max_collateralBonus = BigNumber.from(0);
        var max_collateralPriceInEth = BigNumber.from(0);
        var userDataUIPool = await uipoolContract.getUserReservesData(addresses.LendingPoolAddressesProvider, entry.from);
        var userDatalp = await LendingPoolContract.getUserAccountData(entry.from);
        // console.log(userDataUIPool);
        userDataUIPool[0].forEach((reserve, i) => {
            var priceInEth= poolDataUIPool[0][i].priceInEth;
            var principalBorrowed = reserve.scaledVariableDebt.add(reserve.principalStableDebt);
            if (principalBorrowed.gte(max_borrowedPrincipal)) {
              max_borrowedSymbol = poolDataUIPool[0][i].symbol
              max_borrowedID = i;
              max_borrowedPrincipal = principalBorrowed
              max_borrowedPriceInEth = priceInEth
            }
            if (reserve.scaledATokenBalance.gt(BigNumber.from(0)) && poolDataUIPool[0][i].reserveLiquidationBonus.gt(max_collateralBonus)){
                max_collateralSymbol = poolDataUIPool[0][i].symbol
                max_collateralID = i;
                max_collateralBonus = poolDataUIPool[0][i].reserveLiquidationBonus
                max_collateralPriceInEth = priceInEth
            }
        });
        if (userDatalp.healthFactor.lt(healthFactorMax)) {
            loans.push( {
                "user_id"  :  entry.from,
                "healthFactor"   :  userDatalp.healthFactor,
                "max_collateralSymbol" : max_collateralSymbol,
                "max_collateralID" : max_collateralID,
                "max_borrowedSymbol" : max_borrowedSymbol,
                "max_borrowedID" : max_borrowedID,
                "max_borrowedPrincipal" : max_borrowedPrincipal,
                "max_borrowedPriceInEth" : max_borrowedPriceInEth,
                "max_collateralBonus" : max_collateralBonus,
                "max_collateralPriceInEth" : max_collateralPriceInEth
            });
        }
    }
    // console.log("loans before", loans);
    // console.log("poolDataUIPool[loan.max_borrowedID].decimals", poolDataUIPool[0].decimals);
    // console.log("BigNumber.from(poolDataUIPool[loan.max_borrowedID].decimals)", loans[0].max_borrowedPrincipal .mul(allowedLiquidation).div(100) .mul (loans[0].max_collateralBonus.sub(10000)).div(10000).mul(loans[0].max_borrowedPriceInEth).div(BigNumber.from(10).pow(BigNumber.from(poolDataUIPool[0][loans[0].max_borrowedID].decimals))));
    //filter out loans under a threshold that we know will not be profitable (liquidation_threshold)
    loans = loans.filter(loan => loan.max_borrowedPrincipal .mul(allowedLiquidation).div(100) .mul (loan.max_collateralBonus.sub(10000)).div(10000).mul(loan.max_borrowedPriceInEth).div(BigNumber.from(10).pow(BigNumber.from(poolDataUIPool[0][loan.max_borrowedID].decimals))) >= profit_threshold);
    //remove duplicates
    loans = [...new Map(loans.map((m) => [m.user_id, m])).values()];
    return loans;
}
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("The account:", deployer.address);
    console.log("Account balance before:", (await deployer.getBalance()).toString());
    let LiquidateLoanContract = new ethers.Contract(LiquidateLoanAddr, LiquidateLoanJSON.abi, deployer);
    let SwappiRouterContract = new ethers.Contract(SwappiRouterAddr, SwappiRouterJSON.abi, deployer);
    let uipoolContract = new ethers.Contract(uipoolAddr, uipoolJSON.abi, deployer);
    let LendingPoolContract = new ethers.Contract(LendingPoolAddr, LendingPoolJSON.abi, deployer);
    var blockNumBefore = await ethers.provider.getBlockNumber();
    blockNumBefore = 92568690;
    let scanUrl = `https://evmapi-testnet.confluxscan.net/api?module=account&action=txlist&address=${addresses.LendingPool}&startblock=${blockNumBefore}&sort=desc`;
    const data = await request<User>(scanUrl);
    // console.log(data.result);
    let loans = await parseUsers(data, uipoolContract, LendingPoolContract);
    console.log("loans:", loans);
}
  
main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error);
    process.exit(1);
});