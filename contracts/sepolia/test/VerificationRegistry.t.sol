// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC165, IReceiver} from "../src/IReceiver.sol";
import {VerificationRegistry} from "../src/VerificationRegistry.sol";

contract VerificationRegistryTest is Test {
    address internal constant FORWARDER = address(0xF0);
    address internal constant OPERATOR = address(0x0E);
    address internal constant ATTACKER = address(0xBAD);
    bytes32 internal constant ACTION = bytes32(uint256(0x11) * 0x0101010101010101010101010101010101010101010101010101010101010101);
    // sha256 of the canonical JSON of the fixture report (pinned in packages/chainlink codec.test.ts)
    bytes32 internal constant REPORT_HASH = 0x88f9d335471c38761b4d7dc922ad546c9f697699081ca66a9cfeaf878eed0e4d;
    // keccak256 of the workflow's onReport payload for the same report (pinned in codec.test.ts)
    bytes32 internal constant PAYLOAD_KECCAK = 0x4c88696423293eb6ceab77dab06eaa7e4d8a242c0da924ce9b6be7e881f0a876;

    VerificationRegistry internal registry;

    event InvoiceVerified(bytes32 indexed actionHash, bytes32 indexed reportHash, uint8 result);

    function setUp() public {
        registry = new VerificationRegistry(FORWARDER, OPERATOR, address(0));
    }

    function fixture() internal pure returns (VerificationRegistry.Fields memory) {
        return VerificationRegistry.Fields({
            actionHash: ACTION,
            invoiceId: "in_1QxDemoAws0001",
            invoiceHash: bytes32(uint256(0x22) * 0x0101010101010101010101010101010101010101010101010101010101010101),
            verifiedAmount: "8420000",
            verifiedCurrency: "usd",
            verifiedRecipient: bytes(
                "addr_test1qpe3z9srjllzq27zndk5nxlcrxs8u6tr3lvs00xk3pcauwend7e3wv3tk360w5k3uz2nkneydscpuwp9t2uwggpsfzgsgehreu"
            ),
            status: "open",
            facts: 63,
            result: 1,
            reason: 0,
            triggerId: "6f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11"
        });
    }

    function deliver(bytes32 reportHash, VerificationRegistry.Fields memory f) internal {
        vm.prank(FORWARDER, OPERATOR);
        registry.onReport("", abi.encode(reportHash, f));
    }

    function test_payloadBytesMatchWorkflowEncoder() public pure {
        assertEq(keccak256(abi.encode(REPORT_HASH, fixture())), PAYLOAD_KECCAK);
    }

    function test_storesEveryFieldKeyedByReportHash() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(true, true, false, true, address(registry));
        emit InvoiceVerified(ACTION, REPORT_HASH, 1);
        deliver(REPORT_HASH, fixture());

        VerificationRegistry.Stored memory s = registry.getReport(REPORT_HASH);
        assertEq(abi.encode(s.fields), abi.encode(fixture()));
        assertEq(s.blockTime, 1_800_000_000);
        (bytes32 latest, VerificationRegistry.Stored memory l) = registry.latestReport(ACTION);
        assertEq(latest, REPORT_HASH);
        assertEq(abi.encode(l.fields), abi.encode(fixture()));
    }

    function test_directCallerCannotWrite() public {
        vm.prank(ATTACKER, ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(VerificationRegistry.UnauthorizedForwarder.selector, ATTACKER));
        registry.onReport("", abi.encode(REPORT_HASH, fixture()));
    }

    function test_forwarderCallFromForeignOriginRejected() public {
        vm.prank(FORWARDER, ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(VerificationRegistry.UnauthorizedOrigin.selector, ATTACKER));
        registry.onReport("", abi.encode(REPORT_HASH, fixture()));
    }

    function test_reportHashIsWriteOnce() public {
        deliver(REPORT_HASH, fixture());
        VerificationRegistry.Fields memory forged = fixture();
        forged.verifiedRecipient = bytes("addr_test1attacker");
        vm.prank(FORWARDER, OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(VerificationRegistry.ReportExists.selector, REPORT_HASH));
        registry.onReport("", abi.encode(REPORT_HASH, forged));
    }

    function test_zeroReportHashRejected() public {
        vm.prank(FORWARDER, OPERATOR);
        vm.expectRevert(VerificationRegistry.EmptyReportHash.selector);
        registry.onReport("", abi.encode(bytes32(0), fixture()));
    }

    function test_recheckGetsNewReportAndMovesLatest() public {
        deliver(REPORT_HASH, fixture());
        VerificationRegistry.Fields memory again = fixture();
        again.triggerId = "0b5d7c8e-1111-4c52-9a35-2f4f5d0c9b11";
        bytes32 secondHash = keccak256("second report");
        vm.warp(block.timestamp + 60);
        deliver(secondHash, again);

        (bytes32 latest,) = registry.latestReport(ACTION);
        assertEq(latest, secondHash);
        assertEq(registry.getReport(REPORT_HASH).fields.triggerId, "6f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11");
    }

    function test_unknownKeysRevert() public {
        vm.expectRevert(abi.encodeWithSelector(VerificationRegistry.UnknownReport.selector, REPORT_HASH));
        registry.getReport(REPORT_HASH);
        vm.expectRevert(abi.encodeWithSelector(VerificationRegistry.UnknownReport.selector, ACTION));
        registry.latestReport(ACTION);
    }

    function test_supportsReceiverInterfaces() public view {
        assertTrue(registry.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(registry.supportsInterface(type(IERC165).interfaceId));
        assertFalse(registry.supportsInterface(0xffffffff));
    }

    function test_workflowOwnerCheckForDonForwarder() public {
        address owner = address(0x75E2);
        VerificationRegistry don = new VerificationRegistry(FORWARDER, address(0), owner);
        bytes memory payload = abi.encode(REPORT_HASH, fixture());

        vm.prank(FORWARDER, ATTACKER);
        vm.expectRevert(VerificationRegistry.UnauthorizedWorkflowOwner.selector);
        don.onReport(abi.encodePacked(bytes32(0), bytes10(0), ATTACKER, bytes2(0)), payload);

        vm.prank(FORWARDER, ATTACKER);
        vm.expectRevert(VerificationRegistry.UnauthorizedWorkflowOwner.selector);
        don.onReport(abi.encodePacked(bytes32(0)), payload);

        vm.prank(FORWARDER, ATTACKER);
        don.onReport(abi.encodePacked(bytes32(0), bytes10(0), owner, bytes2(0)), payload);
        (bytes32 latest,) = don.latestReport(ACTION);
        assertEq(latest, REPORT_HASH);
    }
}
