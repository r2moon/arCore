// SPDX-License-Identifier: MIT

pragma solidity ^0.6.6;

contract ClaimManagerMock {
    function mock() external view returns(address) {
        return msg.sender;
    }
    function transferNft(address to, uint256 id) external {
    }
}
