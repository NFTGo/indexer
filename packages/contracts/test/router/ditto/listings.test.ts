import { Contract, ContractReceipt } from "@ethersproject/contracts";
import { parseEther } from "@ethersproject/units";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";
import { expect } from "chai";
import { getDittoContracts } from "../helpers/ditto";
import abiDittoPool from "../../../../sdk/src/ditto/abis/DittoPool.json";

/**
 * run with the following command:
 *
 * BLOCK_NUMBER="9268037" npx hardhat test test/router/ditto/listings.test.ts
 */
describe("DittoModule", () => {
  let poolAddress: string;
  let initialTokenBalance: BigNumber;
  let deployer: SignerWithAddress;
  let marketMaker: SignerWithAddress;
  const traderAddress = "0x00000000000000000000000000000000DeaDBeef";
  let trader: SignerWithAddress;

  let nft: Contract;
  let token: Contract;
  let dittoPool: Contract;
  let dittoPoolFactory: Contract;

  let router: Contract;
  let dittoModule: Contract;
  // random numbers that aren't likely to already have been minted
  const tokenId00 = ethers.BigNumber.from("0x13376969420123");
  const tokenId01 = ethers.BigNumber.from("0x13376969420124");

  beforeEach(async () => {
    ({ nft, token, dittoPoolFactory } = getDittoContracts());
    trader = await ethers.getImpersonatedSigner(traderAddress);
    [deployer, marketMaker] = await ethers.getSigners();
    initialTokenBalance = parseEther("1000");

    router = await ethers
      .getContractFactory("ReservoirV6_0_1", deployer)
      .then((factory) => factory.deploy());
    dittoModule = await ethers
      .getContractFactory("DittoModule", deployer)
      .then((factory) => factory.deploy(deployer.address, router.address));
    const ownerAddress: string = await dittoPoolFactory.owner();
    const ownerSigner: SignerWithAddress = await ethers.getImpersonatedSigner(ownerAddress);
    await dittoPoolFactory.connect(ownerSigner).addRouters([dittoModule.address]);
    // mint the NFTs to the market maker
    await nft.connect(marketMaker).mint(marketMaker.address, tokenId00);
    await nft.connect(marketMaker).mint(marketMaker.address, tokenId01);
    await nft.connect(marketMaker).setApprovalForAll(dittoPoolFactory.address, true);

    //create a pool to trade with, with the NFTs deposited into the pool

    const poolTemplate = {
      isPrivatePool: false,
      templateIndex: 3, // LINEAR
      token: token.address,
      nft: nft.address,
      feeLp: 0,
      owner: marketMaker.address,
      feeAdmin: 0,
      delta: ethers.utils.parseEther("1.01"),
      basePrice: ethers.utils.parseEther("1"),
      nftIdList: [tokenId00, tokenId01],
      initialTokenBalance: 0,
      templateInitData: "0x",
      referrer: "0x",
    };
    const poolManagerTemplate = {
      templateIndex: ethers.constants.MaxUint256,
      templateInitData: "0x",
    };
    const permitterTemplate = {
      templateIndex: ethers.constants.MaxUint256,
      templateInitData: "0x",
      liquidityDepositPermissionData: "0x",
    };
    const creation = await dittoPoolFactory
      .connect(marketMaker)
      .createDittoPool(poolTemplate, poolManagerTemplate, permitterTemplate);
    const result: ContractReceipt = await creation.wait();
    result.events!.forEach((event) => {
      if (event.event === "DittoPoolFactoryDittoPoolCreated") {
        poolAddress = event.args!.dittoPool;
      }
    });
    dittoPool = new ethers.Contract(poolAddress, abiDittoPool, trader);
  });

  it("Accept multiple listings", async () => {
    await nft.ownerOf(tokenId00).then((owner: any) => {
      expect(owner).to.eq(poolAddress);
    });
    await nft.ownerOf(tokenId01).then((owner: any) => {
      expect(owner).to.eq(poolAddress);
    });

    await token.connect(trader).mint(traderAddress, initialTokenBalance);
    await token.balanceOf(traderAddress).then((balance: BigNumber) => {
      expect(balance).to.equal(initialTokenBalance);
    });
    let approve = await token.connect(trader).approve(dittoModule.address, initialTokenBalance);
    await approve.wait();

    // Fetch the current price
    let result = await dittoPool.getBuyNftQuote(2, "0x");
    let inputValue = result[3];

    const fillTo: string = traderAddress;
    const refundTo: string = traderAddress;
    const revertIfIncomplete: boolean = false;
    const tokenAddress: string = token.address;
    const amountPayment: BigNumber = inputValue;

    const eRC20ListingParams = [fillTo, refundTo, revertIfIncomplete, tokenAddress, amountPayment];

    const recipient: string = dittoPool.address;
    const amountFee: BigNumber = parseEther("0");

    const fee = [recipient, amountFee];

    const orderParams = [[tokenId00, tokenId01], "0x"];

    const buyWithERC20 = [[dittoPool.address], [orderParams], eRC20ListingParams, [fee]];

    let data = dittoModule.interface.encodeFunctionData("buyWithERC20", buyWithERC20);

    const executions = [dittoModule.address, data, 0];

    await router.execute([executions]);

    await nft.ownerOf(tokenId00).then((owner: any) => {
      expect(owner).to.eq(fillTo);
    });
    await nft.ownerOf(tokenId01).then((owner: any) => {
      expect(owner).to.eq(fillTo);
    });
  });
});
