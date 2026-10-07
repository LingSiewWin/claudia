// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FxBasisRegistry} from "../src/FxBasisRegistry.sol";

/// Same trust setup as DeployRegistry: Sepolia MockKeystoneForwarder delivers, only the
/// CRE simulate wallet's transactions are accepted.
contract DeployFxBasisRegistry is Script {
    address internal constant SEPOLIA_MOCK_FORWARDER = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;

    function run() external returns (FxBasisRegistry registry) {
        uint256 key = vm.parseUint(string.concat("0x", vm.envString("CRE_ETH_PRIVATE_KEY")));
        address operator = vm.addr(key);
        vm.startBroadcast(key);
        registry = new FxBasisRegistry(SEPOLIA_MOCK_FORWARDER, operator, address(0));
        vm.stopBroadcast();
        console.log("FxBasisRegistry", address(registry));
        console.log("requiredOrigin", operator);
    }
}
