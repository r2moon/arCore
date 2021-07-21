// SPDX-License-Identifier: (c) Armor.Fi DAO, 2021

pragma solidity ^0.6.6;

import '../general/ArmorModule.sol';
import '../general/SafeERC20.sol';
import '../general/BalanceWrapper.sol';
import '../libraries/Math.sol';
import '../libraries/SafeMath.sol';
import '../interfaces/IERC20.sol';
import '../interfaces/IPlanManager.sol';
import '../interfaces/IRewardManagerV2.sol';

/**
 * @dev RewardManagerV2 is a updated RewardManager to distribute rewards.
 *      based on total used cover per protocols.
**/

contract RewardManagerV2 is BalanceWrapper, ArmorModule, IRewardManagerV2 {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount; // How many LP tokens the user has provided.
        uint256 rewardDebt; // Reward debt. See explanation below.
        //
        // We do some fancy math here. Basically, any point in time, the amount of SUSHIs
        // entitled to a user but is pending to be distributed is:
        //
        //   pending reward = (user.amount * pool.accArmorPerShare) - user.rewardDebt
        //
        // Whenever a user deposits or withdraws LP tokens to a pool. Here's what happens:
        //   1. The pool's `accArmorPerShare` (and `lastRewardBlock`) gets updated.
        //   2. User receives the pending reward sent to his/her address.
        //   3. User's `amount` gets updated.
        //   4. User's `rewardDebt` gets updated.
    }
    struct PoolInfo {
        address protocol; // Address of protocol contract.
        uint256 totalStaked; // Total staked amount in the pool
        uint256 allocPoint; // Allocation of protocol.
        uint256 lastRewardBlock; // Last block number that SUSHIs distribution occurs.
        uint256 accArmorPerShare; // Accumulated SUSHIs per share, times 1e12. See below.
        uint256 lastArmorPerBlockIdx; // Last armorPerBlock used.
    }

    IERC20 public rewardToken;

    uint256 public totalAllocPoint;

    uint256[] public armorPerBlocks;
    uint256[] public armorPerBlockUpdatedEpoch;

    uint256 public rewardPeriod = 7 days;

    mapping(address => PoolInfo) public poolInfo;

    mapping(address => mapping(address => UserInfo)) public userInfo;

    constructor(IERC20 _rewardToken) public {
        require(address(_rewardToken) != address(0), "zero");
        rewardToken = _rewardToken;
    }

    function initializeRewardManagerV2(uint256 _armorPerBlock) external {
        require(armorPerBlocks.length == 0, "already initialized");
        addArmorPerBlock(_armorPerBlock);
    }

    function addArmorPerBlock(uint256 _armorPerBlock) public {
        uint remainingReward;
        if (armorPerBlocks.length > 0) {
            uint256 lastIdx = armorPerBlocks.length - 1;
            if (block.number < armorPerBlockUpdatedEpoch[lastIdx].add(rewardPeriod)) {
                remainingReward = armorPerBlockUpdatedEpoch[lastIdx].add(rewardPeriod).sub(block.number).mul(armorPerBlocks[lastIdx]);
            }
        }
        uint256 nextPeriodReward = _armorPerBlock.mul(rewardPeriod);
        if (remainingReward > nextPeriodReward) {
            safeArmorTransfer(msg.sender, remainingReward.sub(nextPeriodReward));
        } else if (remainingReward < nextPeriodReward) {
            rewardToken.safeTransferFrom(msg.sender, address(this), nextPeriodReward.sub(remainingReward));
        }
        armorPerBlocks.push(_armorPerBlock);
        armorPerBlockUpdatedEpoch.push(block.number);
    }

    function updateAllocPoint(address _protocol, uint256 _allocPoint) override external onlyModule("PLAN")  {
        updatePool(_protocol);
        PoolInfo storage pool = poolInfo[_protocol];
        if (poolInfo[_protocol].protocol == address(0)) {
            initPool(_protocol);
        } else {
            totalAllocPoint = totalAllocPoint.sub(pool.allocPoint).add(_allocPoint);
            pool.allocPoint = _allocPoint;
        }
    }

    function initPool(address _protocol) override public onlyModules("PLAN", "STAKE")  {
        PoolInfo storage pool = poolInfo[_protocol];
        require(pool.protocol == address(0), "already initialized");
        pool.protocol = _protocol;
        pool.lastRewardBlock = block.number;
        pool.lastArmorPerBlockIdx = armorPerBlocks.length.sub(1);
        pool.allocPoint = IPlanManager(_master.getModule("PLAN")).totalUsedCover(_protocol);
        totalAllocPoint = totalAllocPoint.add(pool.allocPoint);
    }

    function deposit(address _user, address _protocol, uint256 _amount) override external onlyModules("BALANCE", "STAKE") {
        PoolInfo storage pool = poolInfo[_protocol];
        if (pool.protocol == address(0)) {
            initPool(_protocol);
        } else {
            updatePool(_protocol);
        }
        UserInfo storage user = userInfo[_protocol][_user];
        if (user.amount > 0) {
            uint256 pending =
                user.amount.mul(pool.accArmorPerShare).div(1e12).sub(
                    user.rewardDebt
                );
            safeArmorTransfer(_user, pending);
        }
        user.amount = user.amount.add(_amount);
        user.rewardDebt = user.amount.mul(pool.accArmorPerShare).div(1e12);
        pool.totalStaked = pool.totalStaked.add(_amount);
    }
    
    function withdraw(address _user, address _protocol, uint256 _amount) override public onlyModules("BALANCE", "STAKE"){
        PoolInfo storage pool = poolInfo[_protocol];
        UserInfo storage user = userInfo[_protocol][_user];
        require(user.amount >= _amount, "withdraw: not good");
        updatePool(_protocol);
        uint256 pending =
            user.amount.mul(pool.accArmorPerShare).div(1e12).sub(
                user.rewardDebt
            );
        safeArmorTransfer(_user, pending);
        user.amount = user.amount.sub(_amount);
        user.rewardDebt = user.amount.mul(pool.accArmorPerShare).div(1e12);
        pool.totalStaked = pool.totalStaked.sub(_amount);
    }

    function claimReward(address _protocol) public {
        PoolInfo storage pool = poolInfo[_protocol];
        UserInfo storage user = userInfo[_protocol][msg.sender];

        updatePool(_protocol);
        uint256 pending =
            user.amount.mul(pool.accArmorPerShare).div(1e12).sub(
                user.rewardDebt
            );
        safeArmorTransfer(msg.sender, pending);
        user.rewardDebt = user.amount.mul(pool.accArmorPerShare).div(1e12);
    }

    function claimRewardInBatch(address[] calldata _protocols) external {
        for (uint256 i = 0; i < _protocols.length; i += 1) {
            claimReward(_protocols[i]);
        }
    }

    function getPoolReward(address _protocol) public view returns (uint256 reward) {
        PoolInfo memory pool = poolInfo[_protocol];
        uint256 from = Math.max(pool.lastRewardBlock, armorPerBlockUpdatedEpoch[0]);
        for (uint256 i = pool.lastArmorPerBlockIdx; i < armorPerBlocks.length - 1; i += 1) {
            uint256 to = armorPerBlockUpdatedEpoch[i + 1];
            reward = reward.add(to.sub(from).mul(armorPerBlocks[i]));
            from = to;
        }
        reward = reward.add(block.number.sub(from).mul(armorPerBlocks[armorPerBlocks.length - 1]));
        reward = reward.mul(pool.allocPoint).div(totalAllocPoint);
    }

    function updatePool(address _protocol) public {
        PoolInfo storage pool = poolInfo[_protocol];
        if (block.number <= pool.lastRewardBlock) {
            return;
        }
        if (pool.totalStaked == 0) {
            pool.lastRewardBlock = block.number;
            return;
        }

        uint256 armorReward = getPoolReward(_protocol);
        pool.accArmorPerShare = pool.accArmorPerShare.add(
            armorReward.mul(1e12).div(pool.totalStaked)
        );
        pool.lastRewardBlock = block.number;
        pool.lastArmorPerBlockIdx = armorPerBlocks.length.sub(1);
    }
    
    function safeArmorTransfer(address _to, uint256 _amount) internal {
        uint256 armorBal = rewardToken.balanceOf(address(this));
        if (_amount > armorBal) {
            rewardToken.safeTransfer(_to, armorBal);
        } else {
            rewardToken.safeTransfer(_to, _amount);
        }
    }
}
