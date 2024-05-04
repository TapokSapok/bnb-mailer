const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { EventEmitter } = require('events');

class Database extends EventEmitter {
	constructor() {
		super();
		this.db = null;
		this.init();
	}

	async init() {
		this.db = await open({
			filename: './database.db',
			driver: sqlite3.Database,
		}).then(db => {
			this.emit('connected');
			return db;
		});

		await this.db.exec(`CREATE TABLE IF NOT EXISTS queue(mail TEXT NOT NULL)`);
	}

	async addQueue(mails) {
		return await this.db.run(`INSERT INTO queue (mail) VALUES ${mails.map(h => `("${h}")`).join(', ')};`);
	}

	async getFirstQueue() {
		const mail = await this.db.get(`SELECT * FROM queue ASC LIMIT 1`);
		await this.db.run(`DELETE FROM queue WHERE mail IN (SELECT mail FROM queue LIMIT 1);`);
		return mail;
	}
}

module.exports = new Database();
