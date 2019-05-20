import {Address, TransactionId, WhitelistPayload} from "../types";
import {Server} from "@kinecosystem/kin-sdk";
import {Asset, Keypair, Memo, Network, Operation, Transaction as XdrTransaction, MemoType} from "@kinecosystem/kin-base";
import {KeyPair} from "./keyPair";
import {TransactionBuilder} from "./transactionBuilder";
import {HorizonError, NetworkError, NetworkMismatchedError, ErrorDecoder} from "../errors";
import {Channel} from "./channelsPool";
import {IBlockchainInfoRetriever} from "./blockchainInfoRetriever";
import {CHANNEL_TOP_UP_TX_COUNT} from "../config";
import {TransactionErrorList} from "./errors";

interface WhitelistPayloadTemp {
	// The android stellar sdk spells 'envelope' as 'envelop'
	envelop: string,
	envelope?: string,
	networkId: string
}

export class TxSender {
	constructor(private readonly _keypair: KeyPair, private readonly _appId: string, private readonly _server: Server,
				private readonly _blockchainInfoRetriever: IBlockchainInfoRetriever) {
		this._keypair = _keypair;
		this._appId = _appId;
		this._server = _server;
		this._blockchainInfoRetriever = _blockchainInfoRetriever;
	}

	get appId() {
		return this._appId;
	}

	public async getTransactionBuilder(fee: number, channel?: Channel): Promise<TransactionBuilder> {
		const response = await this.loadSenderAccountData(channel);
		return new TransactionBuilder(this._server, response, {fee: fee, appId: this.appId}, channel)
			.setTimeout(0);
	}

	public async buildCreateAccount(address: Address, startingBalance: number, fee: number, memoText?: string, channel?: Channel): Promise<TransactionBuilder> {
		const response = await this.loadSenderAccountData(channel);
		return new TransactionBuilder(this._server, response, {
			fee: fee,
			memo: memoText ? Memo.text(memoText) : undefined,
			appId: this.appId}
			, channel)
			.setTimeout(0)
			.addOperation(Operation.createAccount({
				source: this._keypair.publicAddress,
				destination: address,
				startingBalance: startingBalance.toString()
			}));
	}

	public async buildSendKin(address: Address, amount: number, fee: number, memoText?: string, channel?: Channel): Promise<TransactionBuilder> {
		const response = await this.loadSenderAccountData(channel);
		return new TransactionBuilder(this._server, response, {
			fee: fee,
			memo: memoText ? Memo.text(memoText) : undefined,
			appId: this.appId
		}, channel)
			.setTimeout(0)
			.addOperation(Operation.payment({
				source: this._keypair.publicAddress,
				destination: address,
				asset: Asset.native(),
				amount: amount.toString()
			}));
	}

	private async loadSenderAccountData(channel?: Channel) {
		const addressToLoad = channel ? channel.keyPair.publicAddress : this._keypair.publicAddress;
		const response: Server.AccountResponse = await this._server.loadAccount(addressToLoad);
		return response;
	}

	public async submitTransaction(builder: TransactionBuilder): Promise<TransactionId> {
		try {
			let tx = builder.build();
			const signers = new Array<Keypair>();
			signers.push(Keypair.fromSecret(this._keypair.seed));
			if (builder.channel) {
				signers.push(Keypair.fromSecret(builder.channel.keyPair.seed));
			}
			tx.sign(...signers);
			//console.debug(tx.toEnvelope().toXDR('base64'));
			let transactionResponse = await this._server.submitTransaction(tx);
			return transactionResponse.hash;
		} catch (e) {
			const error = ErrorDecoder.translate(e);
			if (this.checkForInsufficientChannelFeeBalance(builder, error)) {
				await this.topUpChannel(builder);
				// Insufficient balance is a "fast-fail", the sequence number doesn't increment
				// so there is no need to build the transaction again
				return this.submitTransaction(builder);
			} else {
				throw error;
			}
		}
	}

	private checkForInsufficientChannelFeeBalance(builder: TransactionBuilder, error: HorizonError | NetworkError): boolean {
		if (!builder.channel)
			return false;
		return (error as HorizonError).resultTransactionCode === TransactionErrorList.INSUFFICIENT_BALANCE;
	}


	private async topUpChannel(builder: TransactionBuilder) {
		const channel = builder.channel as Channel;
		const fee = await this._blockchainInfoRetriever.getMinimumFee();
		const amount = fee * CHANNEL_TOP_UP_TX_COUNT;
		const topUpBuilder = await this.buildSendKin(channel.keyPair.publicAddress, amount, fee);
		await this.submitTransaction(topUpBuilder);
	}

	public whitelistTransaction(payload: string | WhitelistPayload): string {
		let txPair: WhitelistPayload | WhitelistPayloadTemp;
		if (typeof payload === "string") {
			let tx = JSON.parse(payload);
			if (tx.envelop != null) {
				txPair = tx as WhitelistPayloadTemp;
				txPair.envelope = txPair.envelop;
			} else {
				txPair = tx as WhitelistPayload;
			}
		} else {
			txPair = payload;
		}

		if (typeof txPair.envelope !== "string") {
			throw new TypeError("'envelope' must be type of string");
		}

		let networkPassphrase = Network.current().networkPassphrase();
		if (networkPassphrase !== txPair.networkId) {
			throw new NetworkMismatchedError();
		}

		const xdrTransaction = new XdrTransaction(txPair.envelope);
		xdrTransaction.sign(Keypair.fromSecret(this._keypair.seed));
		let envelope = xdrTransaction.toEnvelope();
		let buffer = envelope.toXDR('base64');

		return buffer.toString();
	}
}
