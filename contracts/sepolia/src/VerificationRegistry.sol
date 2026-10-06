// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165, IReceiver} from "./IReceiver.sol";

/// @notice Invoice verification reports written by a CRE workflow, keyed by report hash
/// (sha256 of the RFC 8785 canonical JSON report). Every field is stored so a reader can
/// rebuild the canonical report and recompute the key; the key itself is never trusted.
contract VerificationRegistry is IReceiver {
    struct Fields {
        bytes32 actionHash;
        string invoiceId;
        bytes32 invoiceHash;
        string verifiedAmount;
        string verifiedCurrency;
        bytes verifiedRecipient;
        string status;
        uint8 facts;
        uint8 result;
        uint8 reason;
        string triggerId;
    }

    struct Stored {
        Fields fields;
        uint64 blockTime;
    }

    address public immutable FORWARDER;
    /// Required tx.origin, for forwarders that do not authenticate reports (the simulation
    /// MockKeystoneForwarder is permissionless). address(0) disables the check.
    address public immutable REQUIRED_ORIGIN;
    /// Required workflow owner from the forwarder metadata (bytes 42..62). address(0) disables.
    /// At least one of REQUIRED_ORIGIN and REQUIRED_WORKFLOW_OWNER must be set.
    address public immutable REQUIRED_WORKFLOW_OWNER;

    mapping(bytes32 reportHash => Stored) private reports;
    mapping(bytes32 actionHash => bytes32 reportHash) private latest;

    event InvoiceVerified(bytes32 indexed actionHash, bytes32 indexed reportHash, uint8 result);

    error UnauthorizedForwarder(address caller);
    error UnauthorizedOrigin(address origin);
    error UnauthorizedWorkflowOwner();
    error EmptyReportHash();
    error ReportExists(bytes32 reportHash);
    error UnknownReport(bytes32 key);
    error ZeroForwarder();
    error NoReportAuthentication();

    constructor(address forwarder_, address requiredOrigin_, address requiredWorkflowOwner_) {
        if (forwarder_ == address(0)) revert ZeroForwarder();
        if (requiredOrigin_ == address(0) && requiredWorkflowOwner_ == address(0)) revert NoReportAuthentication();
        FORWARDER = forwarder_;
        REQUIRED_ORIGIN = requiredOrigin_;
        REQUIRED_WORKFLOW_OWNER = requiredWorkflowOwner_;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != FORWARDER) revert UnauthorizedForwarder(msg.sender);
        if (REQUIRED_ORIGIN != address(0) && tx.origin != REQUIRED_ORIGIN) revert UnauthorizedOrigin(tx.origin);
        if (
            REQUIRED_WORKFLOW_OWNER != address(0)
                && (metadata.length < 62 || address(bytes20(metadata[42:62])) != REQUIRED_WORKFLOW_OWNER)
        ) revert UnauthorizedWorkflowOwner();
        (bytes32 reportHash, Fields memory fields) = abi.decode(report, (bytes32, Fields));
        if (reportHash == bytes32(0)) revert EmptyReportHash();
        if (reports[reportHash].blockTime != 0) revert ReportExists(reportHash);
        reports[reportHash] = Stored({fields: fields, blockTime: uint64(block.timestamp)});
        latest[fields.actionHash] = reportHash;
        emit InvoiceVerified(fields.actionHash, reportHash, fields.result);
    }

    function getReport(bytes32 reportHash) external view returns (Stored memory stored) {
        stored = reports[reportHash];
        if (stored.blockTime == 0) revert UnknownReport(reportHash);
    }

    function latestReport(bytes32 actionHash) external view returns (bytes32 reportHash, Stored memory stored) {
        reportHash = latest[actionHash];
        if (reportHash == bytes32(0)) revert UnknownReport(actionHash);
        stored = reports[reportHash];
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
