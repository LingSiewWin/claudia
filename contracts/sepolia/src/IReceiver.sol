// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// CRE report receiver interface (docs.chain.link/cre, "Building consumer contracts").
// The forwarder checks ERC-165 support for IReceiver before calling onReport.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
