import "@nomicfoundation/hardhat-toolbox";
require("dotenv").config();
let _privateKey = process.env.PRIVATE_KEY;
if (typeof(_privateKey) == "undefined") {
  _privateKey = "0x1234567890123456789012345678901234567890123456789012345678901234";
}
module.exports = {
  solidity: "0.6.12",
  networks: {
    testnet: {
      url: "http://evmtestnet.confluxrpc.com",
      accounts: [
        _privateKey
      ]
    },
    mainnet: {
      url: "http://evm.confluxrpc.com",
      accounts: [
        _privateKey
      ]
    },
    hardhat: {
      allowUnlimitedContractSize: true
    }
  }
};

