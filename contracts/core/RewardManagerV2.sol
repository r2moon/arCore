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
import "hardhat/console.sol";

/**
 * @dev RewardManagerV2 is a updated RewardManager to distribute rewards.
 *      based on total used cover per protocols.
**/

contract RewardManagerV2 is BalanceWrapper, ArmorModule, IRewardManagerV2 {
    using SafeERC20 for IERC20;

    event RewardPaid(address indexed user, uint256 reward, uint256 timestamp);

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
        uint256 lastRewardPerBlockIdx; // Last rewardPerBlock used.
    }

    IERC20 public rewardToken;

    uint256 public totalAllocPoint;

    uint256[] public rewardPerBlocks;
    uint256[] public rewardUpdatedBlocks;

    uint256 public rewardCycleBlocks;
    uint256 public lastReward;

    mapping(address => PoolInfo) public poolInfo;

    mapping(address => mapping(address => UserInfo)) public userInfo;

    function initialize(address _armorMaster, address _rewardToken, uint _rewardCycleBlocks)
      external
      override
    {
        initializeModule(_armorMaster);
        rewardToken = IERC20(_rewardToken);
        require (_rewardCycleBlocks > 0, "Invalid cycle blocks");
        rewardCycleBlocks = _rewardCycleBlocks;
    }

    function initPool(address _protocol) override public onlyModules("PLAN", "STAKE")  {
        require(_protocol != address(0), "zero address!");
        PoolInfo storage pool = poolInfo[_protocol];
        require(pool.protocol == address(0), "already initialized");
        pool.protocol = _protocol;
        pool.lastRewardBlock = block.number;
        pool.lastRewardPerBlockIdx = rewardPerBlocks.length > 0 ? rewardPerBlocks.length.sub(1) : 0;
        pool.allocPoint = IPlanManager(_master.getModule("PLAN")).totalUsedCover(_protocol);
        totalAllocPoint = totalAllocPoint.add(pool.allocPoint);
    }

    function notifyRewardAmount(uint256 reward) override external payable onlyModule("BALANCE") {
        if (address(rewardToken) == address(0)){
            require(msg.value == reward, "Correct reward was not sent");
        }
        else {
            require(msg.value == 0, "Do not send ETH");
            rewardToken.safeTransferFrom(msg.sender, address(this), reward);
        }

        uint remainingReward;
        if (rewardPerBlocks.length > 0) {
            uint256 lastIdx = rewardPerBlocks.length - 1;
            uint256 usedReward = Math.min(rewardCycleBlocks, block.number.sub(rewardUpdatedBlocks[lastIdx])).mul(rewardPerBlocks[lastIdx]);
            if (usedReward < lastReward) {
                remainingReward = lastReward.sub(usedReward);
            }
        }
        lastReward = reward.add(remainingReward);
        uint256 _rewardPerBlock = lastReward.div(rewardCycleBlocks);
        rewardPerBlocks.push(_rewardPerBlock);
        rewardUpdatedBlocks.push(block.number);
    }

    function updateAllocPoint(address _protocol, uint256 _allocPoint) override external onlyModule("PLAN")  {
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
                    user.amount.mul(pool.accArmorPerShare).div(1e12).sub(
                        user.rewardDebt
                    );
                safeRewardTransfer(_user, pending);
            }
        }
        user.amount = user.amount.add(_amount);
        user.rewardDebt = user.amount.mul(pool.accArmorPerShare).div(1e12);
        pool.totalStaked = pool.totalStaked.add(_amount);
    }

    function withdraw(address _user, address _protocol, uint256 _amount) override public onlyModule("STAKE") {
        PoolInfo storage pool = poolInfo[_protocol];
        UserInfo storage user = userInfo[_protocol][_user];
        require(user.amount >= _amount, "insufficient to withdraw");
        updatePool(_protocol);
        uint256 pending =
            user.amount.mul(pool.accArmorPerShare).div(1e12).sub(
                user.rewardDebt
            );
        if (pending > 0) {
            safeRewardTransfer(_user, pending);
        }
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
        if (pending > 0) {
            safeRewardTransfer(msg.sender, pending);
        }
        user.rewardDebt = user.amount.mul(pool.accArmorPerShare).div(1e12);
    }

    function claimRewardInBatch(address[] calldata _protocols) external {
        for (uint256 i = 0; i < _protocols.length; i += 1) {
            claimReward(_protocols[i]);
        }
    }

    function getPoolReward(address _protocol) public view returns (uint256 reward) {
        PoolInfo memory pool = poolInfo[_protocol];
        if (pool.protocol == address(0)) {
            return 0;
        }
        uint256 from = Math.max(pool.lastRewardBlock, rewardUpdatedBlocks[0]);
        for (uint256 i = pool.lastRewardPerBlockIdx; i < rewardPerBlocks.length - 1; i += 1) {
            uint256 to = rewardUpdatedBlocks[i + 1];
            reward = reward.add(Math.min(to.sub(from), rewardCycleBlocks).mul(rewardPerBlocks[i]));
            from = to;
        }
        reward = reward.add(Math.min(block.number.sub(from), rewardCycleBlocks).mul(rewardPerBlocks[rewardPerBlocks.length - 1]));
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

        uint256 poolReward = getPoolReward(_protocol);
        pool.accArmorPerShare = pool.accArmorPerShare.add(
            poolReward.mul(1e12).div(pool.totalStaked)
        );
        pool.lastRewardBlock = block.number;
        pool.lastRewardPerBlockIdx = rewardPerBlocks.length.sub(1);
    }
    
    function safeRewardTransfer(address _to, uint256 _amount) internal {
        uint reward;
        if (address(rewardToken) == address(0)) {
            reward = Math.min(address(this).balance, _amount);
            payable(_to).transfer(reward);
        } else {
            reward = Math.min(rewardToken.balanceOf(address(this)), _amount);
            rewardToken.safeTransfer(_to, reward);
        }

        emit RewardPaid(_to, reward, block.timestamp);
    }
}
