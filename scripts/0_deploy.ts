import { ethers } from "hardhat";
import hre from 'hardhat';
const networkName = hre.network.name;
let addresses;
if (networkName == 'testnet') {
    addresses = require('./testnetConfig.json');
}else{
    addresses = require('./espaceConfig.json');
}
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);
    console.log("Account balance before:", (await deployer.getBalance()).toString());
    //Deploy LiquidateLoan
    const factory  = await ethers.getContractFactory("LiquidateLoan");
    let LiquidateLoanContract = await factory.deploy(addresses.LendingPoolAddressesProvider, addresses.SwappiRouter);
    await LiquidateLoanContract.deployed();
    console.log("Contract address:", LiquidateLoanContract.address);
    console.log("Account balance after:", (await deployer.getBalance()).toString());
}
  
main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error);
    process.exit(1);
});