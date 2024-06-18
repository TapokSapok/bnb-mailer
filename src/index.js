const nodemailer = require("nodemailer");
const fs = require("fs/promises");
const { Worker } = require("worker_threads");
const crypto = require("crypto");
const config = require("../config.json");
const prisma = require("./prisma");

let count = 0;
let html = null;
let textId = 0;

class Queue {
	constructor() {
		this.queue = [];
		this.nextQueue();
	}

	pushQueue(func, ...args) {
		this.queue.push([func, args]);
	}

	async nextQueue() {
		if (this.queue.length > 0) {
			const func = this.queue.shift();
			const mail = await prisma.queue.findFirst();
			if (mail) await prisma.queue.delete({ where: { id: mail.id } });
			func[0](...func[1], mail?.mail);
			this.nextQueue();
		} else {
			setTimeout(() => this.nextQueue(), 50);
		}
	}
}

function getRandomInt(min, max) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

const queue = new Queue();

const main = async () => {
	await prisma.$connect();
	const accounts = (await fs.readFile("accounts.txt", "utf-8"))
		.split("\n")
		.map((acc) => acc.split(":"))
		.filter((m) => m[0].length);
	if (!accounts.length) return console.log('Нету аккаунтов в "accounts.txt"');
	const mails = (await fs.readFile("mails.txt", "utf-8"))
		.split("\n")
		.filter((m) => m);
	if (mails && mails.length) {
		await prisma.queue.createMany({
			data: mails.map((m) => ({
				mail: m,
			})),
		});
		console.log(`В базу данных добавлено ${mails.length} почт!`);
		await fs.writeFile("mails.txt", "");
	}
	for (let i = 0; i < accounts.length; i++) {
		console.log("Аккаунт:", accounts[i][0]);
		const dkim = generateDKIMKey(accounts[i][0].split("@")[1], "mailru");

		const transport = nodemailer.createTransport({
			host: "smtp.mail.ru",
			port: 465,
			secure: true,
			dkim: {
				domainName: accounts[i][0].split("@")[1],
				keySelector: "mailru",
				privateKey: dkim,
			},
			auth: { user: accounts[i][0], pass: accounts[i][1] },
			proxy: config.proxy ? `socks://${config.proxy}` : null,
		});
		if (config.proxy) transport.set("proxy_socks_module", require("socks"));
		queue.pushQueue(nextMail, transport, accounts[i], dkim);
	}
	console.log("\nВсего аккаунтов:", accounts.length, "\n");
};

const nextMail = async (transport, account, dkim, mail) => {
	if (!mail) return console.log('Закончились почты "mails.txt"');
	let stop = false;

	try {
		const msg = await transport.sendMail({
			from: `${config.messages[0].from} <${account[0]}>`,
			to: mail,
			subject: config.messages[0].subject.replace(
				/%RANDOM%/gi,
				`${getRandomInt(600000, 999999)}`
			),
			text: config.messages[0].text
				? config.messages[0].text
				: config.messages[0].texts && config.messages[0].texts[textId],
			html:
				config.messages[0].html && (await fs.readFile(config.messages[0].html)),
		});
		console.log(config.messages[0].texts[textId]);

		if (config.messages[0].texts) {
			if (textId < config.messages[0].texts.length - 1) {
				textId++;
			} else textId = 0;
		}

		console.log(
			`${count} ${account[0]} ${mail.trim()} ${msg.messageTime}ms - ${
				msg.response.split(" ")[0]
			}`
		);
	} catch (err) {
		if (err.responseCode === 535) {
			console.log("Ошибка авторизации", `${account[0]}:${account[1]}`);
			stop = true;
		} else if (err.responseCode === 451) {
			console.log(err.responseCode, err.response, err.command);
			stop = true;
		} else if (err.responseCode) {
			console.log(err.responseCode, err.response, err.command);
		} else if (err.message.includes("connect ECONNREFUSED")) {
			return console.log("Ошибка прокси", err.message);
		} else {
			console.log("ирр", err);
		}
	}
	count++;
	if (stop) return;
	await new Promise((r) => setTimeout(r, config.sendTimeout));
	queue.pushQueue(nextMail, transport, account, dkim);
};

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

main();
