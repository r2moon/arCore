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

      // TODO check initPool when reward notified before
      // const rewardAmount = ethers.utils.parseUnits("100", 18);

      // await rewardManagerV2
      //   .connect(rewardDistribution)
      //   .notifyRewardAmount({ value: rewardAmount.div(BigNumber.from("2")) });
      // await rewardManagerV2
      //   .connect(rewardDistribution)
      //   .notifyRewardAmount({ value: rewardAmount.div(BigNumber.from("2")) });

      // await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      // currentBlock = await getBlockNumber();
      // expect(await rewardManagerV2.totalAllocPoint()).to.equal(
      //   protocol1Cover.add(protocol2Cover)
      // );
      // pool = await rewardManagerV2.poolInfo(protocol2);
      // expect(pool.protocol).to.equal(protocol2);
      // expect(pool.totalStaked).to.equal(0);
      // expect(pool.allocPoint).to.equal(protocol2Cover);
      // expect(pool.lastRewardBlock).to.equal(currentBlock);
      // expect(pool.lastRewardPerBlockIdx).to.equal(1);
      // expect(pool.accEthPerShare).to.equal(0);
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
      expect(await rewardManagerV2.lastRewardBlock()).to.equal(currentBlock);
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

  // describe("#deposit()", function () {
  //   const rewardAmount = ethers.utils.parseUnits("100", 18);

  //   beforeEach(async function () {
  //     await token
  //       .connect(owner)
  //       .mint(await rewardDistribution.getAddress(), rewardAmount);
  //     await token
  //       .connect(rewardDistribution)
  //       .approve(rewardManagerV2.address, rewardAmount);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);
  //   });

  //   it("should fail if msg.sender is not stake manager", async function () {
  //     const amount = ethers.utils.parseUnits("10", 18);
  //     await expect(
  //       rewardManagerV2
  //         .connect(owner)
  //         .deposit(await alice.getAddress(), protocol1, amount)
  //     ).to.be.revertedWith("only module STAKE can call this function");
  //   });

  //   it("should init pool, if pool is not initialized", async function () {
  //     const amount = ethers.utils.parseUnits("10", 18);
  //     const protocol3 = generateRandomAddress();
  //     const protocol3Cover = ethers.utils.parseUnits("1500", 18);
  //     await planManager.setTotalUsedCover(protocol3, protocol3Cover);

  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .deposit(await alice.getAddress(), protocol3, amount);

  //     let currentBlock = await getBlockNumber();
  //     expect(await rewardManagerV2.totalAllocPoint()).to.equal(protocol3Cover);
  //     let pool = await rewardManagerV2.poolInfo(protocol3);
  //     expect(pool.protocol).to.equal(protocol3);
  //     expect(pool.totalStaked).to.equal(amount);
  //     expect(pool.allocPoint).to.equal(protocol3Cover);
  //     expect(pool.lastRewardBlock).to.equal(currentBlock);
  //     expect(pool.lastRewardPerBlockIdx).to.equal(0);
  //     expect(pool.accEthPerShare).to.equal(0);

  //     let userInfo = await rewardManagerV2.userInfo(
  //       protocol3,
  //       await alice.getAddress()
  //     );
  //     expect(userInfo.amount).to.equal(amount);
  //     expect(userInfo.rewardDebt).to.equal(0);
  //   });

  //   it("should update pool, and send reward to user", async function () {
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);
  //     const amount = ethers.utils.parseUnits("10", 18);

  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .deposit(await alice.getAddress(), protocol1, amount);

  //     let currentBlock = await getBlockNumber();
  //     let pool = await rewardManagerV2.poolInfo(protocol1);
  //     expect(pool.totalStaked).to.equal(amount);
  //     expect(pool.lastRewardBlock).to.equal(currentBlock);
  //     expect(pool.lastRewardPerBlockIdx).to.equal(0);
  //     expect(pool.accEthPerShare).to.equal(0);

  //     let userInfo = await rewardManagerV2.userInfo(
  //       protocol1,
  //       await alice.getAddress()
  //     );
  //     expect(userInfo.amount).to.equal(amount);
  //     expect(userInfo.rewardDebt).to.equal(0);

  //     await mineBlocks(100);
  //     const poolReward = rewardAmount
  //       .div(rewardCycle)
  //       .mul(BigNumber.from("101"))
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     const accEthPerShare = poolReward
  //       .mul(ethers.utils.parseUnits("1", 12))
  //       .div(amount);
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .deposit(await alice.getAddress(), protocol1, "0");

  //     expect(await token.balanceOf(await alice.getAddress())).to.be.equal(
  //       amount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //     userInfo = await rewardManagerV2.userInfo(
  //       protocol1,
  //       await alice.getAddress()
  //     );
  //     expect(userInfo.amount).to.equal(amount);
  //     expect(userInfo.rewardDebt).to.equal(
  //       amount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //   });
  // });

  // describe("#withdraw()", function () {
  //   const rewardAmount = ethers.utils.parseUnits("100", 18);
  //   const depositAmount = ethers.utils.parseUnits("10", 18);

  //   beforeEach(async function () {
  //     await token
  //       .connect(owner)
  //       .mint(await rewardDistribution.getAddress(), rewardAmount);
  //     await token
  //       .connect(rewardDistribution)
  //       .approve(rewardManagerV2.address, rewardAmount);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);

  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .deposit(await alice.getAddress(), protocol1, depositAmount);
  //   });

  //   it("should fail if msg.sender is not stake manager", async function () {
  //     const amount = ethers.utils.parseUnits("10", 18);
  //     await expect(
  //       rewardManagerV2
  //         .connect(owner)
  //         .withdraw(await alice.getAddress(), protocol1, amount)
  //     ).to.be.revertedWith("only module STAKE can call this function");
  //   });

  //   it("should fail if withdraw amount is higher than staked", async function () {
  //     const amount = ethers.utils.parseUnits("15", 18);
  //     await expect(
  //       rewardManagerV2
  //         .connect(stakeManager)
  //         .withdraw(await alice.getAddress(), protocol1, amount)
  //     ).to.be.revertedWith("insufficient to withdraw");
  //   });

  //   it("should update pool, withdraw amount, and send reward to user", async function () {
  //     const amount = ethers.utils.parseUnits("5", 18);

  //     await mineBlocks(100);
  //     const poolReward = rewardAmount
  //       .div(rewardCycle)
  //       .mul(BigNumber.from("101"))
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     const accEthPerShare = poolReward
  //       .mul(ethers.utils.parseUnits("1", 12))
  //       .div(depositAmount);
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .withdraw(await alice.getAddress(), protocol1, amount);

  //     expect(await token.balanceOf(await alice.getAddress())).to.be.equal(
  //       depositAmount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //     let userInfo = await rewardManagerV2.userInfo(
  //       protocol1,
  //       await alice.getAddress()
  //     );
  //     expect(userInfo.amount).to.equal(depositAmount.sub(amount));
  //     expect(userInfo.rewardDebt).to.equal(
  //       depositAmount
  //         .sub(amount)
  //         .mul(accEthPerShare)
  //         .div(ethers.utils.parseUnits("1", 12))
  //     );
  //   });
  // });

  // describe("#claimReward()", function () {
  //   const rewardAmount = ethers.utils.parseUnits("100", 18);
  //   const depositAmount = ethers.utils.parseUnits("10", 18);

  //   beforeEach(async function () {
  //     await token
  //       .connect(owner)
  //       .mint(await rewardDistribution.getAddress(), rewardAmount);
  //     await token
  //       .connect(rewardDistribution)
  //       .approve(rewardManagerV2.address, rewardAmount);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);

  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .deposit(await alice.getAddress(), protocol1, depositAmount);
  //   });

  //   it("should claim reward", async function () {
  //     await mineBlocks(100);
  //     const poolReward = rewardAmount
  //       .div(rewardCycle)
  //       .mul(BigNumber.from("101"))
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     const accEthPerShare = poolReward
  //       .mul(ethers.utils.parseUnits("1", 12))
  //       .div(depositAmount);
  //     await rewardManagerV2.connect(alice).claimReward(protocol1);

  //     expect(await token.balanceOf(await alice.getAddress())).to.be.equal(
  //       depositAmount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //     let userInfo = await rewardManagerV2.userInfo(
  //       protocol1,
  //       await alice.getAddress()
  //     );
  //     expect(userInfo.rewardDebt).to.equal(
  //       depositAmount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //   });
  // });

  // describe("#claimRewardInBatch()", function () {
  //   const rewardAmount = ethers.utils.parseUnits("100", 18);
  //   const depositAmount = ethers.utils.parseUnits("10", 18);

  //   beforeEach(async function () {
  //     await token
  //       .connect(owner)
  //       .mint(await rewardDistribution.getAddress(), rewardAmount);
  //     await token
  //       .connect(rewardDistribution)
  //       .approve(rewardManagerV2.address, rewardAmount);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);

  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .deposit(await alice.getAddress(), protocol1, depositAmount);
  //   });

  //   it("should claim reward", async function () {
  //     await mineBlocks(100);
  //     const poolReward = rewardAmount
  //       .div(rewardCycle)
  //       .mul(BigNumber.from("101"))
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     const accEthPerShare = poolReward
  //       .mul(ethers.utils.parseUnits("1", 12))
  //       .div(depositAmount);
  //     await rewardManagerV2.connect(alice).claimRewardInBatch([protocol1]);

  //     expect(await token.balanceOf(await alice.getAddress())).to.be.equal(
  //       depositAmount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //     let userInfo = await rewardManagerV2.userInfo(
  //       protocol1,
  //       await alice.getAddress()
  //     );
  //     expect(userInfo.rewardDebt).to.equal(
  //       depositAmount.mul(accEthPerShare).div(ethers.utils.parseUnits("1", 12))
  //     );
  //   });
  // });

  // describe("#getPoolReward()", function () {
  //   beforeEach(async function () {
  //     await token
  //       .connect(owner)
  //       .mint(
  //         await rewardDistribution.getAddress(),
  //         ethers.utils.parseUnits("10000000000000000000000", 18)
  //       );
  //     await token
  //       .connect(rewardDistribution)
  //       .approve(
  //         rewardManagerV2.address,
  //         ethers.utils.parseUnits("10000000000000000000000", 18)
  //       );
  //   });

  //   it("should return 0 if pool is not initialized", async function () {
  //     let rewardAmount = ethers.utils.parseUnits("100", 18);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);
  //     await mineBlocks(100);
  //     expect(
  //       await rewardManagerV2.getPoolReward(generateRandomAddress())
  //     ).to.be.equal(0);
  //   });

  //   it("should return correct amount at initial state", async function () {
  //     let rewardAmount = ethers.utils.parseUnits("100", 18);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);

  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);

  //     await mineBlocks(100);
  //     const poolReward = rewardAmount
  //       .div(rewardCycle)
  //       .mul(BigNumber.from("100"))
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     expect(await rewardManagerV2.getPoolReward(protocol1)).to.be.equal(
  //       poolReward
  //     );
  //   });

  //   it("should return correct amount when new reward notified before next cycle", async function () {
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);

  //     let rewardAmount1 = ethers.utils.parseUnits("100", 18);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount1);
  //     await mineBlocks(100);
  //     let remaining1 = rewardAmount1.sub(
  //       rewardAmount1.div(rewardCycle).mul(BigNumber.from("101"))
  //     );
  //     let rewardAmount2 = ethers.utils.parseUnits("200", 18);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount2);

  //     expect(await rewardManagerV2.rewardPerBlocks(0)).to.be.equal(
  //       rewardAmount1.div(rewardCycle)
  //     );
  //     expect(await rewardManagerV2.rewardPerBlocks(1)).to.be.equal(
  //       rewardAmount2.add(remaining1).div(rewardCycle)
  //     );
  //     await mineBlocks(200);
  //     const poolReward = rewardAmount1
  //       .div(rewardCycle)
  //       .mul(BigNumber.from("101"))
  //       .add(
  //         rewardAmount2
  //           .add(remaining1)
  //           .div(rewardCycle)
  //           .mul(BigNumber.from("200"))
  //       )
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     expect(await rewardManagerV2.getPoolReward(protocol1)).to.be.equal(
  //       poolReward
  //     );
  //   });

  //   it("should return correct amount when new reward notified after next cycle", async function () {
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol1);
  //     await rewardManagerV2.connect(stakeManager).initPool(protocol2);

  //     let rewardAmount1 = ethers.utils.parseUnits("100", 18);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount1);
  //     await mineBlocks(rewardCycle.add(BigNumber.from("20")).toNumber());
  //     let rewardAmount2 = ethers.utils.parseUnits("200", 18);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount2);

  //     expect(await rewardManagerV2.rewardPerBlocks(0)).to.be.equal(
  //       rewardAmount1.div(rewardCycle)
  //     );
  //     expect(await rewardManagerV2.rewardPerBlocks(1)).to.be.equal(
  //       rewardAmount2.div(rewardCycle)
  //     );
  //     await mineBlocks(200);
  //     let rewardAmount3 = ethers.utils.parseUnits("150", 18);
  //     let remaining2 = rewardAmount2.sub(
  //       rewardAmount2.div(rewardCycle).mul(BigNumber.from("201"))
  //     );
  //     await mineBlocks(150);
  //     console.log(rewardAmount1.div(rewardCycle).toString());
  //     console.log(
  //       rewardAmount1
  //         .div(rewardCycle)
  //         .mul(rewardCycle)
  //         .add(rewardAmount2.div(rewardCycle).mul(BigNumber.from("200")))
  //         .toString()
  //     );
  //     const poolReward = rewardAmount1
  //       .div(rewardCycle)
  //       .mul(rewardCycle)
  //       .add(rewardAmount2.div(rewardCycle).mul(BigNumber.from("200")))
  //       .add(
  //         rewardAmount3
  //           .add(remaining2)
  //           .div(rewardCycle)
  //           .mul(BigNumber.from("150"))
  //       )
  //       .mul(protocol1Cover)
  //       .div(protocol1Cover.add(protocol2Cover));
  //     expect(await rewardManagerV2.getPoolReward(protocol1)).to.be.equal(
  //       poolReward
  //     );
  //   });
  // });
});
