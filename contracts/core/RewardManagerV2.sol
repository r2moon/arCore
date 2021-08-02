// SPDX-License-Identifier: (c) Armor.Fi DAO, 2021

pragma solidity ^0.6.6;

import '../general/ArmorModule.sol';
import '../general/BalanceWrapper.sol';
import '../libraries/Math.sol';
import '../libraries/SafeMath.sol';
import '../interfaces/IPlanManager.sol';
import '../interfaces/IRewardManagerV2.sol';
import "hardhat/console.sol";

/**
 * @dev RewardManagerV2 is a updated RewardManager to distribute rewards.
 *      based on total used cover per protocols.
**/

contract RewardManagerV2 is BalanceWrapper, ArmorModule, IRewardManagerV2 {
    event RewardPaid(address indexed user, uint256 reward, uint256 timestamp);

    struct UserInfo {
        uint256 amount; // How many LP tokens the user has provided.
        uint256 rewardDebt; // Reward debt.
    }
    struct PoolInfo {
        address protocol; // Address of protocol contract.
        uint256 totalStaked; // Total staked amount in the pool
        uint256 allocPoint; // Allocation of protocol.
        uint256 lastRewardBlock; // Last block number that SUSHIs distribution occurs.
        uint256 accEthPerShare; // Accumulated SUSHIs per share, times 1e12. See below.
        uint256 rewardDebt; // Pool Reward debt. 
    }

    uint256 public totalAllocPoint;
    uint256 public accEthPerAlloc;
    uint256 public lastRewardBlock;
    uint256 public rewardPerBlock;
    uint256 public rewardCycleEnd;
    uint256 public usedReward;

    uint256 public rewardCycle;
    uint256 public lastReward;

    mapping(address => PoolInfo) public poolInfo;

    mapping(address => mapping(address => UserInfo)) public userInfo;

    function initialize(address _armorMaster, uint _rewardCycleBlocks)
      external
      override
    {
        initializeModule(_armorMaster);
        require (_rewardCycleBlocks > 0, "Invalid cycle blocks");
        rewardCycle = _rewardCycleBlocks;
        lastRewardBlock = block.number;
    }

    function notifyRewardAmount() override external payable onlyModule("BALANCE") {
        require(msg.value > 0, "Invalid reward");
        updateReward();
        uint remainingReward = lastReward > usedReward ? lastReward.sub(usedReward) : 0;
        lastReward = msg.value.add(remainingReward);
        usedReward = 0;
        rewardCycleEnd = block.number.add(rewardCycle);
        rewardPerBlock = lastReward.div(rewardCycle);        
    }

    function updateReward() public {
        if (block.number <= lastRewardBlock) {
            return;
        }

        if (rewardCycleEnd == 0 || totalAllocPoint == 0) {
            lastRewardBlock = block.number;
            return;
        }

        uint256 reward = Math.min(rewardCycleEnd, block.number).sub(lastRewardBlock).mul(rewardPerBlock);
        usedReward = usedReward.add(reward);
        accEthPerAlloc = accEthPerAlloc.add(reward.mul(1e12).div(totalAllocPoint));
        lastRewardBlock = block.number;
    }

    function initPool(address _protocol) override public onlyModules("PLAN", "STAKE")  {
        require(_protocol != address(0), "zero address!");
        PoolInfo storage pool = poolInfo[_protocol];
        require(pool.protocol == address(0), "already initialized");
        updateReward();
        pool.protocol = _protocol;
        pool.lastRewardBlock = block.number;
        pool.allocPoint = IPlanManager(_master.getModule("PLAN")).totalUsedCover(_protocol);
        totalAllocPoint = totalAllocPoint.add(pool.allocPoint);
        pool.rewardDebt = pool.totalStaked.mul(accEthPerAlloc).div(1e12);
    }

    function updateAllocPoint(address _protocol, uint256 _allocPoint) override external onlyModule("PLAN")  {
        updateReward();
        PoolInfo storage pool = poolInfo[_protocol];
        if (poolInfo[_protocol].protocol == address(0)) {
            initPool(_protocol);
        } else {
            updatePool(_protocol);
            totalAllocPoint = totalAllocPoint.sub(pool.allocPoint).add(_allocPoint);
            pool.allocPoint = _allocPoint;
        }
    }

    function deposit(address _user, address _protocol, uint256 _amount) override external onlyModule("STAKE") {
        PoolInfo storage pool = poolInfo[_protocol];
        UserInfo storage user = userInfo[_protocol][_user];
        if (pool.protocol == address(0)) {
            initPool(_protocol);
        } else {
            updatePool(_protocol);
            if (user.amount > 0) {
                uint256 pending =
                    user.amount.mul(pool.accEthPerShare).div(1e12).sub(
                        user.rewardDebt
                    );
                safeRewardTransfer(_user, pending);
            }
        }
        user.amount = user.amount.add(_amount);
        user.rewardDebt = user.amount.mul(pool.accEthPerShare).div(1e12);
        pool.totalStaked = pool.totalStaked.add(_amount);
    }

    function withdraw(address _user, address _protocol, uint256 _amount) override public onlyModule("STAKE") {
        PoolInfo storage pool = poolInfo[_protocol];
        UserInfo storage user = userInfo[_protocol][_user];
        require(user.amount >= _amount, "insufficient to withdraw");
        updatePool(_protocol);
        uint256 pending =
            user.amount.mul(pool.accEthPerShare).div(1e12).sub(
                user.rewardDebt
            );
        if (pending > 0) {
            safeRewardTransfer(_user, pending);
        }
        user.amount = user.amount.sub(_amount);
        user.rewardDebt = user.amount.mul(pool.accEthPerShare).div(1e12);
        pool.totalStaked = pool.totalStaked.sub(_amount);
    }

    function claimReward(address _protocol) public {
        PoolInfo storage pool = poolInfo[_protocol];
        UserInfo storage user = userInfo[_protocol][msg.sender];

        updatePool(_protocol);
        uint256 pending =
            user.amount.mul(pool.accEthPerShare).div(1e12).sub(
                user.rewardDebt
            );
        user.rewardDebt = user.amount.mul(pool.accEthPerShare).div(1e12);
        if (pending > 0) {
            safeRewardTransfer(msg.sender, pending);
        }
    }

    function claimRewardInBatch(address[] calldata _protocols) external {
        for (uint256 i = 0; i < _protocols.length; i += 1) {
            claimReward(_protocols[i]);
        }
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

        updateReward();
        uint poolReward = pool.allocPoint.mul(accEthPerAlloc).div(1e12).sub(
            pool.rewardDebt
        );
        pool.accEthPerShare = pool.accEthPerShare.add(
            poolReward.mul(1e12).div(pool.totalStaked)
        );
        pool.lastRewardBlock = block.number;
        pool.rewardDebt = pool.allocPoint.mul(accEthPerAlloc).div(1e12);
    }
    
    function safeRewardTransfer(address _to, uint256 _amount) internal {
        uint reward = Math.min(address(this).balance, _amount);
        payable(_to).transfer(reward);

        emit RewardPaid(_to, reward, block.timestamp);
    }
}
