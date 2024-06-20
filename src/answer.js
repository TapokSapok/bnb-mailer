const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const prisma = require("./prisma");
const fs = require("fs/promises");
const config = require("../config.json");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");
const cl = require("colors");

const bot = new Telegraf(config.bot_token);

let queue = [];
let queueStarted = false;

bot.on("message", async (ctx) => {
	if (ctx?.update?.message?.reply_to_message?.message_id) {
		const acc = await prisma.account.findUnique({
			where: { messageId: ctx?.update?.message?.reply_to_message?.message_id },
		});
		if (acc?.waitLink) {
			await prisma.account.update({
				where: {
					messageId: ctx?.update?.message?.reply_to_message?.message_id,
				},
				data: { link: ctx.message.text, waitLink: false },
			});
			console.log(cl.dim(`new link: ${ctx.message.text}`));
			ctx.reply(`new link: ${ctx.message.text}`);
		}
	}
});

const generateDKIMKey = (domain, selector) => {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
		modulusLength: 1024,
		publicKeyEncoding: {
			type: "spki",
			format: "pem",
		},
		privateKeyEncoding: {
			type: "pkcs8",
			format: "pem",
		},
	});

	const formattedPublicKey = publicKey
		.replace("-----BEGIN PUBLIC KEY-----", "")
		.replace("-----END PUBLIC KEY-----", "")
		.replace(/\r\n/g, "")
		.trim();

	return privateKey;
};

const queueRound = async (
	acc,
	accountId,
	link,
	localCount,
	transport,
	dkim
) => {
	let stop = null;
	if (!queue.length)
		return setTimeout(
			() => queueRound(acc, accountId, link, localCount, transport, dkim),
			500
		);
	const parsed = queue[0];
	const messages = await prisma.message.findMany({
		where: { to: parsed.from.value[0].address },
	});

	if (messages.length + 1 >= config.messages.length) {
		queue.splice(0, 1);
		console.log(
			`${parsed.from.value[0].address} уже отвечен ${messages.length} раз`
		);
		return setTimeout(
			() => queueRound(acc, accountId, link, localCount, transport, dkim),
			500
		);
	}
	await prisma.message.create({
		data: {
			from: acc[0],
			to: parsed.from.value[0].address,
		},
	});

	if (localCount % config.url_change_interval === 0) {
		await new Promise(async (resolve) => {
			const message = await bot.telegram.sendMessage(
				config.user_id,
				`${accountId} ожидает новый линк`
			);

			await prisma.account.update({
				where: { id: accountId },
				data: {
					waitLink: true,
					link: null,
					messageId: message.message_id,
				},
			});

			const interval = setInterval(async () => {
				const acc = await prisma.account.findUnique({
					where: { id: accountId },
				});

				if (acc?.link) {
					link = acc.link;
					clearInterval(interval);
					resolve();
				}
			}, 500);
		});
	}

	if (!link) return console.log(acc[0], "нет линка");

	try {
		const msg = await transport.sendMail({
			from: `${
				config.messages[
					messages ? messages.length + (messages.length > 1 ? 0 : 1) : 1
				].from
			} <${acc[0]}>`,
			to: parsed.from.value[0].address,
			inReplyTo: parsed.messageId,
			references: [parsed.messageId],
			dkim: {
				domainName: acc[0].split("@")[1],
				keySelector: "mailru",
				privateKey: dkim,
			},
			subject: `Re: ${parsed.subject}`,
			text: config.messages[
				messages ? messages.length + (messages.length > 1 ? 0 : 1) : 1
			].text,
			html: await fs.readFile(
				config.messages[
					messages ? messages.length + (messages.length > 1 ? 0 : 1) : 1
				].html.replace(/%url%/gi, link),
				"utf-8"
			),
			attachments: [
				{
					content: Buffer.from(
						await fs.readFile("screen.jpg", "base64"),
						"base64"
					),
					filename: "screenshot_55.jpg",
				},
				{
					content: Buffer.from(
						await fs.readFile("screen2.jpg", "base64"),
						"base64"
					),
					filename: "screenshot_56.jpg",
				},
			],
		});

		localCount++;
		console.log(localCount, parsed.from.value[0].address, "отправил");
	} catch (err) {
		if (err.responseCode === 535) {
			console.log("Ошибка авторизации", `${acc[0]}:${acc[1]}`);
			stop = true;
		} else if (err.responseCode === 451) {
			console.log(err.responseCode, err.response, err.command);
			stop = true;
		} else if (err.responseCode) {
			console.log(err.responseCode, err.response, err.command);
		} else {
			console.log(err);
		}
	}

	queue.splice(0, 1);

	if (stop) return;
	await new Promise((r) => setTimeout(r, config.answer_message_interval));
	queueRound(acc, accountId, link, localCount, transport, dkim);
};

const main = async () => {
	await prisma.$connect();

	const accounts = (await fs.readFile("accounts.txt", "utf-8"))
		.split("\n")
		.map((acc) => acc.split(":"))
		.filter((m) => m[0].length);
	if (!accounts.length) return console.log('Нету аккаунтов в "accounts.txt"');
	console.log("\nВсего аккаунтов:", accounts.length, "\n");

	for (let i = 0; i < accounts.length; i++) {
		console.log("Аккаунт:", accounts[i][0]);
		const transport = nodemailer.createTransport({
			host: "smtp.mail.ru",
			port: 465,
			secure: true,
			auth: { user: accounts[i][0], pass: accounts[i][1] },
		});
		const imap = new Imap({
			user: accounts[i][0],
			password: accounts[i][1],
			host: "imap.mail.ru",
			port: 993,
			tls: true,
		});
		const dkim = generateDKIMKey(accounts[i][0].split("@")[1], "mailru");
		let localCount = 0;
		let link = null;
		let accountId = crypto.randomUUID().split("-")[0];

		const account = await prisma.account.create({ data: { id: accountId } });

		imap.once("ready", () => {
			const inbox = () => {
				imap.openBox("INBOX", false, () => {
					imap.search(["UNSEEN"], (err, results) => {
						try {
							const f = imap.fetch(results, { bodies: "" });
							f.on("message", (msg) => {
								msg.on("body", (stream) => {
									simpleParser(stream, async (err, parsed) => {
										queue.push(parsed);
										if (!queueStarted) {
											queueStarted = true;
											queueRound(
												accounts[i],
												accountId,
												link,
												localCount,
												transport,
												dkim
											);
										}
									});
								});
								msg.once("attributes", (attrs) => {
									const { uid } = attrs;
									imap.addFlags(uid, ["\\Seen"], () => {});
								});
							});
							f.once("end", () => {
								imap.end();
							});
						} catch (error) {
							console.log("INBOX", accounts[i][0], error.message);
						}
					});
				});
			};

			imap.openBox("Спам", false, () => {
				imap.search(["UNSEEN"], (err, results) => {
					try {
						const f = imap.fetch(results, { bodies: "" });
						f.on("message", (msg) => {
							msg.once("attributes", (attrs) => {
								const { uid } = attrs;

								imap.move(uid, "INBOX", function (err) {
									if (err) {
										console.log(err?.message);
									}
								});
							});
						});
						f.once("end", () => {
							inbox();
						});
					} catch (error) {
						inbox();
						console.log("SPAM", accounts[i][0], error.message);
					}
				});
			});
		});
		imap.connect();
	}
};
main();

bot.launch();
