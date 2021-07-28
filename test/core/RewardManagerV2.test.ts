import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer, BigNumber, constants } from "ethers";
import { time } from "@openzeppelin/test-helpers";
import { increase, mineBlocks, getBlockNumber } from "../utils";

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

  let user: Signer;
  let owner: Signer;
  let rewardDistribution: Signer;
  let rewardCycleBlocks = BigNumber.from("8640"); // 1 day

  beforeEach(async function () {
    accounts = await ethers.getSigners();
    user = accounts[4];
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
      .initialize(master.address, token.address, rewardCycleBlocks);
    await master
      .connect(owner)
      .registerModule(stringToBytes32("REWARDV2"), rewardManagerV2.address);
    rewardManagerV2ETH = await RewardFactoryV2.deploy();
    await rewardManagerV2ETH
      .connect(owner)
      .initialize(master.address, constants.AddressZero, rewardCycleBlocks);

    const PlanFactory = await ethers.getContractFactory("PlanManager");
    planManager = await PlanFactory.deploy();
    await planManager.connect(owner).initialize(master.address);

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
        rewardManagerV2
          .connect(owner)
          .initialize(master.address, token.address, rewardCycleBlocks)
      ).to.be.revertedWith("already initialized");
    });
  });

  describe("#initPool()", function () {
    const protocol1 = generateRandomAddress();
    const protocol1Cover = BigNumber.from("1000");
    const protocol2 = generateRandomAddress();
    const protocol2Cover = BigNumber.from("2000");

    beforeEach(async function () {
      const PlanMockFactory = await ethers.getContractFactory(
        "PlanManagerMock"
      );
      planManager = await PlanMockFactory.deploy();
      await master
        .connect(owner)
        .registerModule(stringToBytes32("PLAN"), planManager.address);
      await planManager.setTotalUsedCover(protocol1, protocol1Cover);
      await planManager.setTotalUsedCover(protocol2, protocol2Cover);
    });

    it("should fail if msg.sender is not stake manager nor balance manager", async function () {
      await expect(
        rewardManagerV2.connect(user).initPool(protocol1)
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
      expect(pool.lastRewardPerBlockIdx).to.equal(0);
      expect(pool.accArmorPerShare).to.equal(0);

      const rewardAmount = ethers.utils.parseUnits("100", 18);
      await token
        .connect(owner)
        .transfer(await rewardDistribution.getAddress(), rewardAmount);
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, rewardAmount);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount.div(BigNumber.from("2")));
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount.div(BigNumber.from("2")));

      await rewardManagerV2.connect(stakeManager).initPool(protocol2);
      currentBlock = await getBlockNumber();
      expect(await rewardManagerV2.totalAllocPoint()).to.equal(
        protocol1Cover.add(protocol2Cover)
      );
      pool = await rewardManagerV2.poolInfo(protocol2);
      expect(pool.protocol).to.equal(protocol2);
      expect(pool.totalStaked).to.equal(0);
      expect(pool.allocPoint).to.equal(protocol2Cover);
      expect(pool.lastRewardBlock).to.equal(currentBlock);
      expect(pool.lastRewardPerBlockIdx).to.equal(1);
      expect(pool.accArmorPerShare).to.equal(0);
    });

    it("should fail to initialize pool again", async function () {
      await rewardManagerV2.connect(stakeManager).initPool(protocol1);
      await expect(
        rewardManagerV2.connect(stakeManager).initPool(protocol1)
      ).to.be.revertedWith("already initialized");
    });
  });

  describe("#notifyRewardAmount()", function () {
    it("should fail if msg.sender is not balance manager", async function () {
      await token
        .connect(owner)
        .transfer(await rewardDistribution.getAddress(), 10000);
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, 10000);
      await expect(
        rewardManagerV2.connect(user).notifyRewardAmount(100)
      ).to.be.revertedWith("only module BALANCE can call this function");
    });

    it("should fail if token is not approved", async function () {
      await token
        .connect(owner)
        .transfer(await rewardDistribution.getAddress(), 10000);
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, 1);
      await expect(
        rewardManagerV2.connect(rewardDistribution).notifyRewardAmount(100)
      ).to.be.reverted;
    });

    it("should fail if rewardToken is token and msg.value is not zero", async function () {
      await token
        .connect(owner)
        .transfer(await rewardDistribution.getAddress(), 10000);
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, 10000);
      await expect(
        rewardManagerV2
          .connect(rewardDistribution)
          .notifyRewardAmount(100, { value: 1 })
      ).to.be.revertedWith("Do not send ETH");
    });

    it("should fail if rewardToken is ETH and msg.value is not same as amount", async function () {
      await expect(
        rewardManagerV2ETH
          .connect(rewardDistribution)
          .notifyRewardAmount(100, { value: 1 })
      ).to.be.revertedWith("Correct reward was not sent");
    });

    it("should increase reward and push rewardPerBlock", async function () {
      const rewardAmount = ethers.utils.parseUnits("100", 18);

      // ERC20 reward
      await token
        .connect(owner)
        .transfer(await rewardDistribution.getAddress(), rewardAmount);
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, rewardAmount);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount);
      let currentBlock = await getBlockNumber();
      expect(await token.balanceOf(rewardManagerV2.address)).to.equal(
        rewardAmount
      );
      expect(await rewardManagerV2.rewardPerBlocks(0)).to.equal(
        rewardAmount.div(rewardCycleBlocks)
      );
      expect(await rewardManagerV2.rewardUpdatedBlocks(0)).to.equal(
        currentBlock
      );

      // ETH reward
      await rewardManagerV2ETH
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount, { value: rewardAmount });
      currentBlock = await getBlockNumber();
      expect(
        await owner.provider.getBalance(rewardManagerV2ETH.address)
      ).to.equal(rewardAmount);
      expect(await rewardManagerV2ETH.rewardPerBlocks(0)).to.equal(
        rewardAmount.div(rewardCycleBlocks)
      );
      expect(await rewardManagerV2ETH.rewardUpdatedBlocks(0)).to.equal(
        currentBlock
      );
    });

    it("should sum up with remaining reward", async function () {
      const rewardAmount = ethers.utils.parseUnits("100", 18);
      const rewardAmount2 = ethers.utils.parseUnits("150", 18);
      // ERC20 reward
      await token
        .connect(owner)
        .transfer(
          await rewardDistribution.getAddress(),
          rewardAmount.add(rewardAmount2)
        );
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, rewardAmount.add(rewardAmount2));
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount);
      let currentBlock = await getBlockNumber();
      await mineBlocks(100);
      let remaining = rewardAmount.sub(
        rewardAmount.div(rewardCycleBlocks).mul(BigNumber.from("101"))
      );
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount2);
      currentBlock = await getBlockNumber();
      expect(await rewardManagerV2.rewardPerBlocks(1)).to.equal(
        rewardAmount2.add(remaining).div(rewardCycleBlocks)
      );
      expect(await rewardManagerV2.rewardUpdatedBlocks(1)).to.equal(
        currentBlock
      );

      // ETH reward
      await rewardManagerV2ETH
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount, { value: rewardAmount });
      currentBlock = await getBlockNumber();
      await mineBlocks(100);
      remaining = rewardAmount.sub(
        rewardAmount.div(rewardCycleBlocks).mul(BigNumber.from("101"))
      );
      await rewardManagerV2ETH
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount2, { value: rewardAmount2 });
      currentBlock = await getBlockNumber();
      expect(await rewardManagerV2ETH.rewardPerBlocks(1)).to.equal(
        rewardAmount2.add(remaining).div(rewardCycleBlocks)
      );
      expect(await rewardManagerV2ETH.rewardUpdatedBlocks(1)).to.equal(
        currentBlock
      );
    });

    it("should notify after reward cycle", async function () {
      const rewardAmount = ethers.utils.parseUnits("100", 18);
      const rewardAmount2 = ethers.utils.parseUnits("150", 18);
      // ERC20 reward
      await token
        .connect(owner)
        .transfer(
          await rewardDistribution.getAddress(),
          rewardAmount.add(rewardAmount2)
        );
      await token
        .connect(rewardDistribution)
        .approve(rewardManagerV2.address, rewardAmount.add(rewardAmount2));
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount);

      await rewardManagerV2ETH
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount, { value: rewardAmount });

      await mineBlocks(rewardCycleBlocks.toNumber() + 10);
      await rewardManagerV2
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount2);
      let currentBlock = await getBlockNumber();
      expect(await rewardManagerV2.rewardPerBlocks(1)).to.equal(
        rewardAmount2.div(rewardCycleBlocks)
      );
      expect(await rewardManagerV2.rewardUpdatedBlocks(1)).to.equal(
        currentBlock
      );

      // ETH reward
      await rewardManagerV2ETH
        .connect(rewardDistribution)
        .notifyRewardAmount(rewardAmount2, { value: rewardAmount2 });
      currentBlock = await getBlockNumber();
      expect(await rewardManagerV2ETH.rewardPerBlocks(1)).to.equal(
        rewardAmount2.div(rewardCycleBlocks)
      );
      expect(await rewardManagerV2ETH.rewardUpdatedBlocks(1)).to.equal(
        currentBlock
      );
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
  //     await expect(
  //       rewardManagerV2
  //         .connect(owner)
  //         .deposit(await user.getAddress(), amount, NFTID)
  //     ).to.be.revertedWith("only module STAKE can call this function");
  //   });

  //   it("should increase total supply", async function () {
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .stake(await user.getAddress(), amount, NFTID);
  //     expect(await rewardManagerV2.totalSupply()).to.be.equal(amount);
  //   });

  //   it("should increase balanceOf user", async function () {
  //     const address = await user.getAddress();
  //     await rewardManagerV2.connect(stakeManager).stake(address, amount, NFTID);
  //     expect(await rewardManagerV2.balanceOf(address)).to.be.equal(amount);
  //   });
  // });

  // describe("#withdraw()", function () {
  //   const NFTID = 1;
  //   beforeEach(async function () {
  //     await token
  //       .connect(owner)
  //       .mint(await rewardDistribution.getAddress(), rewardAmount);
  //     await token
  //       .connect(rewardDistribution)
  //       .approve(rewardManagerV2.address, rewardAmount);
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .stake(await user.getAddress(), amount, NFTID);
  //     await rewardManagerV2
  //       .connect(rewardDistribution)
  //       .notifyRewardAmount(rewardAmount);
  //     await increase(100);
  //   });

  //   it("should fail if msg.sender is not stake manager", async function () {
  //     await expect(
  //       rewardManagerV2
  //         .connect(owner)
  //         .withdraw(await user.getAddress(), amount, NFTID)
  //     ).to.be.revertedWith("only module STAKE can call this function");
  //   });

  //   it("should decrease total supply", async function () {
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .withdraw(await user.getAddress(), amount, NFTID);
  //     expect(await rewardManagerV2.totalSupply()).to.be.equal(0);
  //   });

  //   it("should decrease balanceOf user", async function () {
  //     const address = await user.getAddress();
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .withdraw(address, amount, NFTID);
  //     expect(await rewardManagerV2.balanceOf(address)).to.be.equal(0);
  //   });

  //   it("should not decrease reward amount", async function () {
  //     const address = await user.getAddress();
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .withdraw(address, amount, NFTID);
  //     expect(await rewardManagerV2.rewards(address)).to.not.equal(0);
  //   });
  // });

  // describe("#getReward()", function () {
  //   const NFTID = 1;
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
  //     await rewardManagerV2
  //       .connect(stakeManager)
  //       .stake(await user.getAddress(), amount, NFTID);
  //     await increase(86400 * 10);
  //     await mine();
  //   });

  //   it("should be rewarded for all reward amount", async function () {
  //     const earned = await rewardManagerV2.earned(await user.getAddress());
  //     await rewardManagerV2.getReward(await user.getAddress());
  //     const balance = await token.balanceOf(await user.getAddress());
  //     expect(earned).to.be.equal(balance);
  //   });

  //   it("should do nothing when earned is zero", async function () {
  //     await rewardManagerV2.getReward(await owner.getAddress());
  //   });
  // });
});
