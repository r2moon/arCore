import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer, BigNumber, constants } from "ethers";
import { time } from "@openzeppelin/test-helpers";
import { increase, mineBlocks, getBlockNumber } from "../utils";

const rewardUnit = ethers.utils.parseUnits("1", 12);

function stringToBytes32(str: string): string {
  return ethers.utils.formatBytes32String(str);
}
function generateRandomAddress(): string {
  return ethers.Wallet.createRandom().address;
}

describe("RewardManagerV2", function () {
  let accounts: Signer[];
  let rewardManagerV2: Contract;
  let rewardManagerV2ETH: Contract;
  let stakeManager: Signer;
  let planManager: Contract;
  let token: Contract;
  let master: Contract;

  let alice: Signer;
  let bob: Signer;
  let owner: Signer;
  let rewardDistribution: Signer;
  let rewardCycle = BigNumber.from("8640"); // 1 day

  const protocol1 = generateRandomAddress();
  const protocol1Cover = BigNumber.from("1000");
  const protocol2 = generateRandomAddress();
  const protocol2Cover = BigNumber.from("2000");

  beforeEach(async function () {
    accounts = await ethers.getSigners();
    alice = accounts[4];
    bob = accounts[5];
    owner = accounts[0];
    rewardDistribution = accounts[2];
    stakeManager = accounts[1];

    const MasterFactory = await ethers.getContractFactory("ArmorMaster");
    master = await MasterFactory.deploy();
    await master.connect(owner).initialize();

    const TokenFactory = await ethers.getContractFactory("ERC20Mock");
    token = await TokenFactory.connect(owner).deploy();

    const RewardFactoryV2 = await ethers.getContractFactory("RewardManagerV2");
    rewardManagerV2 = await RewardFactoryV2.deploy();
    await rewardManagerV2
      .connect(owner)
      .initialize(master.address, rewardCycle);
    await master
      .connect(owner)
      .registerModule(stringToBytes32("REWARDV2"), rewardManagerV2.address);

    const PlanMockFactory = await ethers.getContractFactory("PlanManagerMock");
    planManager = await PlanMockFactory.deploy();
    await planManager.setTotalUsedCover(protocol1, protocol1Cover);
    await planManager.setTotalUsedCover(protocol2, protocol2Cover);

    await master
      .connect(owner)
      .registerModule(
        stringToBytes32("STAKE"),
        await stakeManager.getAddress()
      );

    // Edited contract for reward distribution to just be BalanceManager.
    await master
      .connect(owner)
      .registerModule(
        stringToBytes32("BALANCE"),
        await rewardDistribution.getAddress()
      );

    await master
      .connect(owner)
      .registerModule(stringToBytes32("PLAN"), planManager.address);
  });

  describe("#initialize()", function () {
    it("should fail if already initialized", async function () {
      await expect(
        rewardManagerV2.connect(owner).initialize(master.address, rewardCycle)
      ).to.be.revertedWith("already initialized");
    });
  });

  describe("#initPool()", function () {
    it("should fail if msg.sender is not stake manager nor balance manager", async function () {
      await expect(
        rewardManagerV2.connect(alice).initPool(protocol1)
      ).to.be.revertedWith("only module PLAN or STAKE can call this function");
    });

    it("should fail if protocol is zero address", async function () {
      await expect(
        rewardManagerV2.connect(stakeManager).initPool(constants.AddressZero)
      ).to.be.revertedWith("zero address!");
    });

    it("should initialize pool", async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      let currentBlock = await getBlockNumber();
      expect(await rewardManagerV2.totalAllocPoint()).to.equal(protocol1Cover);
      let pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.protocol).to.equal(protocol1);
      expect(pool.totalStaked).to.equal(0);
      expect(pool.allocPoint).to.equal(protocol1Cover);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(0);
      expect(pool.rewardDebt).to.equal(0);
    });

    it("should initialize pool after reward notified", async function () {
      const rewardAmount = ethers.utils.parseUnits("100", 18);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });
      let currentBlock = await getBlockNumber();
      await mineBlocks(100);
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);

      expect(await rewardManagerV2.totalAllocPoint()).to.equal(protocol1Cover);
      let pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.protocol).to.equal(protocol1);
      expect(pool.totalStaked).to.equal(0);
      expect(pool.allocPoint).to.equal(protocol1Cover);
      // expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(0);
      expect(pool.rewardDebt).to.equal(0);
    });
  });

  describe("#notifyRewardAmount()", function () {
    it("should fail if msg.sender is not balance manager", async function () {
      await expect(
        rewardManagerV2.connect(alice).notifyRewardAmount({ value: 100 })
      ).to.be.revertedWith("only module BALANCE can call this function");
    });

    it("should fail if amount is zero", async function () {
      await expect(
        rewardManagerV2.connect(rewardDistribution).notifyRewardAmount()
      ).to.be.revertedWith("Invalid reward");
    });

    it("should init reward info for first reward notification", async function () {
      const rewardAmount = ethers.utils.parseUnits("100", 18);

      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });
      let currentBlock = await getBlockNumber();
      expect(await owner.provider.getBalance(rewardManagerV2.address)).to.equal(
        rewardAmount
      );
      expect(await rewardManagerV2.rewardPerBlock()).to.equal(
        rewardAmount.div(rewardCycle)
      );
      expect(await rewardManagerV2.rewardCycleEnd()).to.equal(
        currentBlock.add(rewardCycle)
      );
      expect(await rewardManagerV2.lastRewardBlock()).to.equal(currentBlock);
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(0);
      expect(await rewardManagerV2.usedReward()).to.equal(0);
      expect(await rewardManagerV2.lastReward()).to.equal(rewardAmount);
    });

    it("should keep reward when totalAllocPoint is zero", async function () {
      // currentBlock = await getBlockNumber();

      const rewardAmount = ethers.utils.parseUnits("100", 18);
      const rewardAmount2 = ethers.utils.parseUnits("150", 18);

      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });
      await mineBlocks(10);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount2 });
      let currentBlock = await getBlockNumber();
      expect(await owner.provider.getBalance(rewardManagerV2.address)).to.equal(
        rewardAmount.add(rewardAmount2)
      );
      expect(await rewardManagerV2.rewardPerBlock()).to.equal(
        rewardAmount.add(rewardAmount2).div(rewardCycle)
      );
      expect(await rewardManagerV2.rewardCycleEnd()).to.equal(
        currentBlock.add(rewardCycle)
      );
      // expect(await rewardManagerV2.lastRewardBlock()).to.equal(currentBlock);
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(0);
      expect(await rewardManagerV2.usedReward()).to.equal(0);
      expect(await rewardManagerV2.lastReward()).to.equal(
        rewardAmount.add(rewardAmount2)
      );
    });

    it("should update reward info", async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      const rewardAmount = ethers.utils.parseUnits("100", 18);
      const rewardAmount2 = ethers.utils.parseUnits("150", 18);

      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });
      await mineBlocks(100);
      const usedReward = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("101"));
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount2 });
      let currentBlock = await getBlockNumber();
      expect(await owner.provider.getBalance(rewardManagerV2.address)).to.equal(
        rewardAmount.add(rewardAmount2)
      );
      expect(await rewardManagerV2.rewardPerBlock()).to.equal(
        rewardAmount.sub(usedReward).add(rewardAmount2).div(rewardCycle)
      );
      expect(await rewardManagerV2.rewardCycleEnd()).to.equal(
        currentBlock.add(rewardCycle)
      );
      expect(await rewardManagerV2.lastRewardBlock()).to.equal(currentBlock);
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(
        usedReward.mul(rewardUnit).div(protocol1Cover.add(protocol2Cover))
      );
      expect(await rewardManagerV2.usedReward()).to.equal(0);
      expect(await rewardManagerV2.lastReward()).to.equal(
        rewardAmount.sub(usedReward).add(rewardAmount2)
      );
    });

    it("should update reward info correctly when notified after cycle end", async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      const rewardAmount = ethers.utils.parseUnits("100", 18);
      const rewardAmount2 = ethers.utils.parseUnits("150", 18);

      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });
      await mineBlocks(rewardCycle.add(BigNumber.from("100")).toNumber());
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount2 });
      let currentBlock = await getBlockNumber();
      expect(await owner.provider.getBalance(rewardManagerV2.address)).to.equal(
        rewardAmount.add(rewardAmount2)
      );
      const lastReward = rewardAmount
        .sub(rewardAmount.div(rewardCycle).mul(rewardCycle))
        .add(rewardAmount2);
      expect(await rewardManagerV2.rewardPerBlock()).to.equal(
        lastReward.div(rewardCycle)
      );
      expect(await rewardManagerV2.rewardCycleEnd()).to.equal(
        currentBlock.add(rewardCycle)
      );
      expect(await rewardManagerV2.lastRewardBlock()).to.equal(currentBlock);
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(
        rewardAmount
          .div(rewardCycle)
          .mul(rewardCycle)
          .mul(rewardUnit)
          .div(protocol1Cover.add(protocol2Cover))
      );
      expect(await rewardManagerV2.usedReward()).to.equal(0);
      expect(await rewardManagerV2.lastReward()).to.equal(lastReward);
    });
  });

  describe("#deposit()", function () {
    const rewardAmount = ethers.utils.parseUnits("100", 18);

    beforeEach(async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });
    });

    it("should fail if msg.sender is not stake manager", async function () {
      const amount = ethers.utils.parseUnits("10", 18);
      await expect(
        rewardManagerV2
          .connect(owner)
          .deposit(await alice.getAddress(), protocol1, amount)
      ).to.be.revertedWith("only module STAKE can call this function");
    });

    it("should init pool, if pool is not initialized", async function () {
      const amount = ethers.utils.parseUnits("10", 18);
      const protocol3 = generateRandomAddress();
      const protocol3Cover = ethers.utils.parseUnits("1500", 18);
      await planManager.setTotalUsedCover(protocol3, protocol3Cover);

      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol3, amount);

      let currentBlock = await getBlockNumber();
      expect(await rewardManagerV2.totalAllocPoint()).to.equal(
        protocol1Cover.add(protocol2Cover.add(protocol3Cover))
      );
      let pool = await rewardManagerV2.poolInfo(protocol3);
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("2"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(accEthPerAlloc);
      expect(pool.protocol).to.equal(protocol3);
      expect(pool.totalStaked).to.equal(amount);
      expect(pool.allocPoint).to.equal(protocol3Cover);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.rewardDebt).to.equal(
        protocol3Cover.mul(accEthPerAlloc).div(rewardUnit)
      );
      expect(pool.accEthPerShare).to.equal(0);

      let userInfo = await rewardManagerV2.userInfo(
        protocol3,
        await alice.getAddress()
      );
      expect(userInfo.amount).to.equal(amount);
      expect(userInfo.rewardDebt).to.equal(0);
    });

    it("should update pool, and send reward to user", async function () {
      const amount = ethers.utils.parseUnits("10", 18);
      const balanceBefore = await owner.provider.getBalance(
        await alice.getAddress()
      );
      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, amount);

      let currentBlock = await getBlockNumber();
      let pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.totalStaked).to.equal(amount);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(0);
      expect(pool.rewardDebt).to.equal(0);

      let userInfo = await rewardManagerV2.userInfo(
        protocol1,
        await alice.getAddress()
      );
      expect(userInfo.amount).to.equal(amount);
      expect(userInfo.rewardDebt).to.equal(0);

      await mineBlocks(100);
      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, "0");
      currentBlock = await getBlockNumber();
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("102"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(accEthPerAlloc);
      const poolReward = accEthPerAlloc.mul(protocol1Cover).div(rewardUnit);
      const accEthPerShare = poolReward.mul(rewardUnit).div(amount);
      pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.totalStaked).to.equal(amount);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(accEthPerShare);
      expect(pool.rewardDebt).to.equal(poolReward);
      const balanceAfter = await owner.provider.getBalance(
        await alice.getAddress()
      );
      expect(balanceAfter.sub(balanceBefore)).to.equal(
        amount.mul(accEthPerShare).div(rewardUnit)
      );
      userInfo = await rewardManagerV2.userInfo(
        protocol1,
        await alice.getAddress()
      );
      expect(userInfo.amount).to.equal(amount);
      expect(userInfo.rewardDebt).to.equal(
        amount.mul(accEthPerShare).div(rewardUnit)
      );
    });
  });

  describe("#withdraw()", function () {
    const rewardAmount = ethers.utils.parseUnits("100", 18);
    const depositAmount = ethers.utils.parseUnits("10", 18);

    beforeEach(async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });

      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, depositAmount);
    });

    it("should fail if msg.sender is not stake manager", async function () {
      const amount = ethers.utils.parseUnits("10", 18);
      await expect(
        rewardManagerV2
          .connect(owner)
          .withdraw(await alice.getAddress(), protocol1, amount)
      ).to.be.revertedWith("only module STAKE can call this function");
    });

    it("should fail if withdraw amount is higher than staked", async function () {
      const amount = ethers.utils.parseUnits("15", 18);
      await expect(
        rewardManagerV2
          .connect(stakeManager)
          .withdraw(await alice.getAddress(), protocol1, amount)
      ).to.be.revertedWith("insufficient to withdraw");
    });

    it("should update pool, withdraw amount, and send reward to user", async function () {
      const amount = ethers.utils.parseUnits("4", 18);
      const balanceBefore = await owner.provider.getBalance(
        await alice.getAddress()
      );
      await mineBlocks(100);
      await rewardManagerV2
        .connect(stakeManager)
        .withdraw(await alice.getAddress(), protocol1, amount);
      let currentBlock = await getBlockNumber();
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("102"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(accEthPerAlloc);
      const poolReward = accEthPerAlloc.mul(protocol1Cover).div(rewardUnit);
      const accEthPerShare = poolReward.mul(rewardUnit).div(depositAmount);
      let pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.totalStaked).to.equal(depositAmount.sub(amount));
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(accEthPerShare);
      expect(pool.rewardDebt).to.equal(poolReward);

      const balanceAfter = await owner.provider.getBalance(
        await alice.getAddress()
      );
      expect(balanceAfter.sub(balanceBefore)).to.equal(
        depositAmount.mul(accEthPerShare).div(rewardUnit)
      );
      let userInfo = await rewardManagerV2.userInfo(
        protocol1,
        await alice.getAddress()
      );
      expect(userInfo.amount).to.equal(depositAmount.sub(amount));
      expect(userInfo.rewardDebt).to.equal(
        depositAmount.sub(amount).mul(accEthPerShare).div(rewardUnit)
      );
    });
  });

  describe("#claimReward()", function () {
    const rewardAmount = ethers.utils.parseUnits("100", 18);
    const depositAmount = ethers.utils.parseUnits("10", 18);

    beforeEach(async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });

      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, depositAmount);
    });

    it("should claim reward", async function () {
      await mineBlocks(100);
      const balanceBefore = await owner.provider.getBalance(
        await alice.getAddress()
      );
      await rewardManagerV2
        .connect(alice)
        .claimReward(protocol1, { gasPrice: 0 });
      let currentBlock = await getBlockNumber();
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("102"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(accEthPerAlloc);
      const poolReward = accEthPerAlloc.mul(protocol1Cover).div(rewardUnit);
      const accEthPerShare = poolReward.mul(rewardUnit).div(depositAmount);
      let pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.totalStaked).to.equal(depositAmount);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(accEthPerShare);
      expect(pool.rewardDebt).to.equal(poolReward);

      const balanceAfter = await owner.provider.getBalance(
        await alice.getAddress()
      );
      expect(balanceAfter.sub(balanceBefore)).to.equal(
        depositAmount.mul(accEthPerShare).div(rewardUnit)
      );
      let userInfo = await rewardManagerV2.userInfo(
        protocol1,
        await alice.getAddress()
      );
      expect(userInfo.amount).to.equal(depositAmount);
      expect(userInfo.rewardDebt).to.equal(
        depositAmount.mul(accEthPerShare).div(rewardUnit)
      );
    });
  });

  describe("#claimRewardInBatch()", function () {
    const rewardAmount = ethers.utils.parseUnits("100", 18);
    const depositAmount = ethers.utils.parseUnits("10", 18);

    beforeEach(async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });

      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, depositAmount);
    });

    it("should claim reward", async function () {
      await mineBlocks(100);
      const balanceBefore = await owner.provider.getBalance(
        await alice.getAddress()
      );
      await rewardManagerV2
        .connect(alice)
        .claimRewardInBatch([protocol1], { gasPrice: 0 });
      let currentBlock = await getBlockNumber();
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("102"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      expect(await rewardManagerV2.accEthPerAlloc()).to.equal(accEthPerAlloc);
      const poolReward = accEthPerAlloc.mul(protocol1Cover).div(rewardUnit);
      const accEthPerShare = poolReward.mul(rewardUnit).div(depositAmount);
      let pool = await rewardManagerV2.poolInfo(protocol1);
      expect(pool.totalStaked).to.equal(depositAmount);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.accEthPerShare).to.equal(accEthPerShare);
      expect(pool.rewardDebt).to.equal(poolReward);

      const balanceAfter = await owner.provider.getBalance(
        await alice.getAddress()
      );
      expect(balanceAfter.sub(balanceBefore)).to.equal(
        depositAmount.mul(accEthPerShare).div(rewardUnit)
      );
      let userInfo = await rewardManagerV2.userInfo(
        protocol1,
        await alice.getAddress()
      );
      expect(userInfo.amount).to.equal(depositAmount);
      expect(userInfo.rewardDebt).to.equal(
        depositAmount.mul(accEthPerShare).div(rewardUnit)
      );
    });
  });

  describe("#getPendingReward()", function () {
    const rewardAmount = ethers.utils.parseUnits("100", 18);
    const depositAmount = ethers.utils.parseUnits("10", 18);

    beforeEach(async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });

      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, depositAmount);
    });

    it("should return pending rewards", async function () {
      await mineBlocks(100);
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("101"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      const poolReward = accEthPerAlloc.mul(protocol1Cover).div(rewardUnit);
      const accEthPerShare = poolReward.mul(rewardUnit).div(depositAmount);

      expect(
        await rewardManagerV2.getPendingReward(
          await alice.getAddress(),
          protocol1
        )
      ).to.equal(depositAmount.mul(accEthPerShare).div(rewardUnit));
    });
  });

  describe("#getTotalPendingReward()", function () {
    const rewardAmount = ethers.utils.parseUnits("100", 18);
    const depositAmount = ethers.utils.parseUnits("10", 18);

    beforeEach(async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount({ value: rewardAmount });

      await rewardManagerV2
        .connect(stakeManager)
        .deposit(await alice.getAddress(), protocol1, depositAmount);
    });

    it("should return pending rewards", async function () {
      await mineBlocks(100);
      const accEthPerAlloc = rewardAmount
        .div(rewardCycle)
        .mul(BigNumber.from("101"))
        .mul(rewardUnit)
        .div(protocol1Cover.add(protocol2Cover));
      const poolReward = accEthPerAlloc.mul(protocol1Cover).div(rewardUnit);
      const accEthPerShare = poolReward.mul(rewardUnit).div(depositAmount);

      expect(
        await rewardManagerV2.getTotalPendingReward(await alice.getAddress(), [
          protocol1,
          protocol2,
        ])
      ).to.equal(depositAmount.mul(accEthPerShare).div(rewardUnit));
    });
  });
});
