const nodemailer = require('nodemailer');
const fs = require('fs/promises');
const { Worker } = require('worker_threads');
const database = require('./database');
const crypto = require('crypto');
const config = require('../config.json');

let count = 0;

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
			const mail = await database.getFirstQueue();
			func[0](...func[1], mail);
			this.nextQueue();
		} else {
			setTimeout(() => this.nextQueue(), 50);
		}
	}
}

const queue = new Queue();

const main = async () => {
	const accounts = (await fs.readFile('accounts.txt', 'utf-8'))
		.split('\n')
		.map(acc => acc.split(':'))
		.filter(m => m[0].length);
	if (!accounts.length) return console.log('Нету аккаунтов в "accounts.txt"');
	const mails = (await fs.readFile('mails.txt', 'utf-8')).split('\n').filter(m => m);
	if (mails && mails.length) {
		await database.addQueue(mails);
		console.log(`В базу данных добавлено ${mails.length} почт!`);
		await fs.writeFile('mails.txt', '');
	}
	for (let i = 0; i < accounts.length; i++) {
		console.log('Аккаунт:', accounts[i][0]);
		const transport = nodemailer.createTransport({ host: 'smtp.mail.ru', port: 465, secure: true, auth: { user: accounts[i][0], pass: accounts[i][1] } });
		const dkim = generateDKIMKey(accounts[i][0].split('@')[1], 'mailru');
		queue.pushQueue(nextMail, transport, accounts[i], dkim);
	}
	console.log('\nВсего аккаунтов:', accounts.length, '\n');
};

const nextMail = async (transport, account, dkim, mail) => {
	if (!mail) return console.log('Закончились почты "mails.txt"');
	mail = mail.mail;
	let stop = false;

	try {
		const msg = await transport.sendMail({
			from: `${config.from} <${account[0]}>`,
			to: mail,
			dkim: {
				domainName: account[0].split('@')[1],
				keySelector: 'mailru',
				privateKey: dkim,
			},
			subject: config.subject,
			text: config.text,
		});
		console.log(count, account[0], mail, `${msg.messageTime}ms`, '-', msg.response.split(' ')[0]);
	} catch (err) {
		if (err.responseCode === 535) {
			console.log('Ошибка авторизации', `${account[0]}:${account[1]}`);
			stop = true;
		} else if (err.responseCode === 451) {
			console.log(err.responseCode, err.response, err.command);
			stop = true;
		} else if (err.responseCode) {
			console.log(err.responseCode, err.response, err.command);
		}
	}
	count++;
	if (stop) return;
	await new Promise(r => setTimeout(r, 1000));
	queue.pushQueue(nextMail, transport, account, dkim);
};

const generateDKIMKey = (domain, selector) => {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: 1024,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem',
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem',
		},
	});

	const formattedPublicKey = publicKey.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(/\r\n/g, '').trim();

	return privateKey;
};

database.on('connected', () => main());
