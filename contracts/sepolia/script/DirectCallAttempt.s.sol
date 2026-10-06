// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VerificationRegistry} from "../src/VerificationRegistry.sol";

/// Sends onReport straight to the registry from the deployer wallet (not the forwarder).
/// Expected: the transaction is mined and reverts with UnauthorizedForwarder.
contract DirectCallAttempt is Script {
    function run(address registry) external {
        uint256 key = vm.parseUint(string.concat("0x", vm.envString("CRE_ETH_PRIVATE_KEY")));
        VerificationRegistry.Fields memory f;
        f.actionHash = keccak256("direct-call-attempt");
        f.invoiceId = "in_forged";
        f.verifiedRecipient = bytes("addr_test1attacker");
        f.facts = 63;
        f.result = 1;
        f.triggerId = "direct-call-attempt";
        bytes memory data = abi.encodeCall(VerificationRegistry.onReport, ("", abi.encode(keccak256("forged"), f)));
        vm.broadcast(key);
        (bool ok,) = registry.call{gas: 300_000}(data);
        require(!ok, "direct call was accepted");
        console.log("direct onReport reverted locally; broadcasting the attempt");
    }
}
