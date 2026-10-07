// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VerificationRegistry} from "../src/VerificationRegistry.sol";

/// Deploys the registry for `cre workflow simulate --broadcast`: the Sepolia MockKeystoneForwarder
/// delivers reports, and only transactions sent by the deployer (the CRE simulate wallet) are accepted.
contract DeployRegistry is Script {
    address internal constant SEPOLIA_MOCK_FORWARDER = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;

    function run() external returns (VerificationRegistry registry) {
        // CRE_ETH_PRIVATE_KEY is stored as 64 hex characters without a 0x prefix (CRE CLI format).
        uint256 key = vm.parseUint(string.concat("0x", vm.envString("CRE_ETH_PRIVATE_KEY")));
        address operator = vm.addr(key);
        vm.startBroadcast(key);
        registry = new VerificationRegistry(SEPOLIA_MOCK_FORWARDER, operator, address(0));
        vm.stopBroadcast();
        console.log("VerificationRegistry", address(registry));
        console.log("requiredOrigin", operator);
    }
}
