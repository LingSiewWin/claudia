// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerificationRegistry} from "../src/VerificationRegistry.sol";

interface IMockKeystoneForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata signatures)
        external;
}

/// Runs against the real MockKeystoneForwarder deployed on Sepolia (used by `cre workflow simulate --broadcast`).
/// Its report() is permissionless, so the registry must not accept reports transmitted by anyone else.
contract MockForwarderForkTest is Test {
    address internal constant MOCK_FORWARDER = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;
    address internal constant OPERATOR = 0x75E2220957250D13263Ac880EE24FA4F32FfB474;
    address internal constant ATTACKER = address(0xBAD);
    bytes32 internal constant ACTION = keccak256("action");
    bytes32 internal constant REPORT_HASH = keccak256("report");

    VerificationRegistry internal registry;

    function setUp() public {
        vm.createSelectFork("sepolia");
        registry = new VerificationRegistry(MOCK_FORWARDER, OPERATOR, address(0));
    }

    // Raw report = 109-byte forwarder header (metadata at 45..109) followed by the workflow payload.
    function rawReport() internal pure returns (bytes memory) {
        VerificationRegistry.Fields memory f;
        f.actionHash = ACTION;
        f.invoiceId = "in_forged";
        f.verifiedRecipient = bytes("addr_test1attacker");
        f.facts = 63;
        f.result = 1;
        f.triggerId = "forged";
        return bytes.concat(new bytes(109), abi.encode(REPORT_HASH, f));
    }

    function test_forgedReportViaMockForwarderIsNotStored() public {
        vm.prank(ATTACKER, ATTACKER);
        IMockKeystoneForwarder(MOCK_FORWARDER).report(address(registry), rawReport(), "", new bytes[](0));
        vm.expectRevert(abi.encodeWithSelector(VerificationRegistry.UnknownReport.selector, ACTION));
        registry.latestReport(ACTION);
    }

    function test_operatorReportViaMockForwarderIsStored() public {
        vm.prank(OPERATOR, OPERATOR);
        IMockKeystoneForwarder(MOCK_FORWARDER).report(address(registry), rawReport(), "", new bytes[](0));
        (bytes32 latest,) = registry.latestReport(ACTION);
        assertEq(latest, REPORT_HASH);
    }
}
