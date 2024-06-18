const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const prisma = require("./prisma");
const fs = require("fs/promises");
const config = require("../config.json");
const crypto = require("crypto");

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

  const formattedPublicKey = publicKey.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\r\n/g, "").trim();

  return privateKey;
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

    imap.once("ready", () => {
      imap.openBox("INBOX", false, () => {
        imap.search(["UNSEEN", ["SINCE", new Date()]], (err, results) => {
          try {
            const f = imap.fetch(results, { bodies: "" });
            f.on("message", (msg) => {
              msg.on("body", (stream) => {
                simpleParser(stream, async (err, parsed) => {
                  const messages = await prisma.message.findMany({ where: { to: parsed.from.value[0].address } });
                  if (messages.length + 1 >= config.messages.length)
                    return console.log(`${parsed.from.value[0].address} уже отвечен ${messages.length} раз`);
                  await prisma.message.create({ data: { from: accounts[i][0], to: parsed.from.value[0].address } });

                  try {
                    const msg = await transport.sendMail({
                      from: `${config.messages[messages ? messages.length + (messages.length > 1 ? 0 : 1) : 1].from} <${accounts[i][0]}>`,
                      to: parsed.from.value[0].address,
                      inReplyTo: parsed.messageId,
                      references: [parsed.messageId],
                      dkim: {
                        domainName: accounts[i][0].split("@")[1],
                        keySelector: "mailru",
                        privateKey: dkim,
                      },
                      subject: `Re: ${parsed.subject}`,
                      text: config.messages[messages ? messages.length + (messages.length > 1 ? 0 : 1) : 1].text,
                    });
                    console.log(parsed.from.value[0].address, "отправил");
                  } catch (err) {
                    if (err.responseCode === 535) {
                      console.log("Ошибка авторизации", `${accounts[i][0]}:${accounts[i][1]}`);
                      stop = true;
                    } else if (err.responseCode === 451) {
                      console.log(err.responseCode, err.response, err.command);
                      stop = true;
                    } else if (err.responseCode) {
                      console.log(err.responseCode, err.response, err.command);
                    }
                  }
                });
              });
              msg.once("attributes", (attrs) => {
                const { uid } = attrs;
                imap.addFlags(uid, ["\\Seen"], () => {});
              });
            });
            f.once("end", () => {
              console.log(accounts[i][0], "Done fetching all messages!");
              imap.end();
            });
          } catch (error) {
            console.log(accounts[i][0], error.message);
          }
        });
      });
    });
    imap.connect();
  }
};
main();
