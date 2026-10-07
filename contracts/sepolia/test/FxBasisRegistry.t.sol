// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC165, IReceiver} from "../src/IReceiver.sol";
import {FxBasisRegistry} from "../src/FxBasisRegistry.sol";

contract FxBasisRegistryTest is Test {
    address internal constant FORWARDER = address(0xF0);
    address internal constant OPERATOR = address(0x0E);
    address internal constant ATTACKER = address(0xBAD);
    bytes32 internal constant ACTION = bytes32(uint256(0xAB) * 0x0101010101010101010101010101010101010101010101010101010101010101);
    // Pinned in packages/chainlink test/fx-codec.test.ts: sha256 of the canonical fixture report and
    // keccak256 of the workflow's onReport payload for it.
    bytes32 internal constant REPORT_HASH = 0xf610c9563b0cdcc808457a33b822624fde3aa231d5b820bf2e1166dea3b0355b;
    bytes32 internal constant PAYLOAD_KECCAK = 0x6a6063126942a845735257a00317b1f14f7a70e2390942a7b5843379f1e5cb93;

    FxBasisRegistry internal registry;

    event FxBasisAttested(bytes32 indexed actionHash, bytes32 indexed reportHash, uint8 result);

    function setUp() public {
        registry = new FxBasisRegistry(FORWARDER, OPERATOR, address(0));
    }

    function fixture() internal pure returns (FxBasisRegistry.Fields memory) {
        return FxBasisRegistry.Fields({
            actionHash: ACTION,
            quoteId: "q_demo_001",
            corridor: "USD-BRL",
            lockedRate: "4.98",
            marketRateAtQuote: "4.96692093",
            chainlinkMid: "4.96692093",
            chainlinkRoundId: 18446744073709551981,
            chainlinkUpdatedAt: 1791288527,
            feedAddress: 0x3126E7F38D5f60f4E2B6ec3511C7bdbD79317Df1,
            basisBps: 0,
            maxBasisBps: 50,
            feedAgeS: 80473,
            maxFeedAgeS: 86400,
            marketOpen: true,
            result: 1,
            triggerId: "trig-1"
        });
    }

    function deliver(bytes32 reportHash, FxBasisRegistry.Fields memory f) internal {
        vm.prank(FORWARDER, OPERATOR);
        registry.onReport("", abi.encode(reportHash, f));
    }

    function test_payloadBytesMatchWorkflowEncoder() public pure {
        assertEq(keccak256(abi.encode(REPORT_HASH, fixture())), PAYLOAD_KECCAK);
    }

    function test_storesEveryFieldKeyedByReportHash() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(true, true, false, true, address(registry));
        emit FxBasisAttested(ACTION, REPORT_HASH, 1);
        deliver(REPORT_HASH, fixture());

        FxBasisRegistry.Stored memory s = registry.getReport(REPORT_HASH);
        assertEq(abi.encode(s.fields), abi.encode(fixture()));
        assertEq(s.blockTime, 1_800_000_000);
        (bytes32 latest, FxBasisRegistry.Stored memory l) = registry.latestReport(ACTION);
        assertEq(latest, REPORT_HASH);
        assertEq(abi.encode(l.fields), abi.encode(fixture()));
    }

    function test_directCallerCannotWrite() public {
        vm.prank(ATTACKER, ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(FxBasisRegistry.UnauthorizedForwarder.selector, ATTACKER));
        registry.onReport("", abi.encode(REPORT_HASH, fixture()));
    }

    function test_forwarderWithWrongOriginCannotWrite() public {
        vm.prank(FORWARDER, ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(FxBasisRegistry.UnauthorizedOrigin.selector, ATTACKER));
        registry.onReport("", abi.encode(REPORT_HASH, fixture()));
    }

    function test_rejectsDuplicateAndEmptyHash() public {
        deliver(REPORT_HASH, fixture());
        vm.prank(FORWARDER, OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(FxBasisRegistry.ReportExists.selector, REPORT_HASH));
        registry.onReport("", abi.encode(REPORT_HASH, fixture()));
        vm.prank(FORWARDER, OPERATOR);
        vm.expectRevert(FxBasisRegistry.EmptyReportHash.selector);
        registry.onReport("", abi.encode(bytes32(0), fixture()));
    }

    function test_unknownReportReverts() public {
        vm.expectRevert(abi.encodeWithSelector(FxBasisRegistry.UnknownReport.selector, REPORT_HASH));
        registry.getReport(REPORT_HASH);
        vm.expectRevert(abi.encodeWithSelector(FxBasisRegistry.UnknownReport.selector, ACTION));
        registry.latestReport(ACTION);
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(registry.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(registry.supportsInterface(type(IERC165).interfaceId));
        assertFalse(registry.supportsInterface(0xffffffff));
    }
}
