// SPDX-License-Identifier: MIT

pragma solidity ^0.6.6;

interface IRewardManagerV2 {
    function initialize(address _rewardToken, address _stakeManager) external;
    function deposit(address _user, address _protocol, uint256 _amount) external;
    function withdraw(address _user, address _protocol, uint256 _amount) external;
    function updateAllocPoint(address _protocol, uint256 _allocPoint) external;
    function initPool(address _protocol) external;
    function notifyRewardAmount(uint256 reward) external payable;
}
