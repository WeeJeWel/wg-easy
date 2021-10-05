'use strict';

const fs = require('fs').promises;
const path = require('path');

const debug = require('debug')('WireGuard');
const uuid = require('uuid');
const QRCode = require('qrcode');

const Util = require('./Util');
const ServerError = require('./ServerError');

const {
  WG_PATH,
  WG_HOST,
  WG_PORT,
  WG_DEFAULT_DNS,
  WG_DEFAULT_ADDRESS,
  WG_PERSISTENT_KEEPALIVE,
  WG_ALLOWED_IPS,
} = require('../config');

module.exports = class WireGuard {

  async getConfig() {
    if (!this.__configPromise) {
      this.__configPromise = Promise.resolve().then(async () => {
        if (!WG_HOST) {
          throw new Error('WG_HOST Environment Variable Not Set!');
        }

        debug('Loading configuration...');
        let config;
        try {
          config = await fs.readFile(path.join(WG_PATH, 'wg0.json'), 'utf8');
          config = JSON.parse(config);
          debug('Configuration loaded.');
        } catch (err) {
          const privateKey = await Util.exec('wg genkey');
          const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
            log: 'echo ***hidden*** | wg pubkey',
          });
          const address = WG_DEFAULT_ADDRESS.replace('x', '1');

          config = {
            server: {
              privateKey,
              publicKey,
              address,
            },
            clients: {},
          };
          debug('Configuration generated.');
        }

        await this.__saveConfig(config);
        await Util.exec('wg-quick down wg0').catch(() => { });
        await Util.exec('wg-quick up wg0');
        await Util.exec(`iptables -t nat -A POSTROUTING -s ${WG_DEFAULT_ADDRESS.replace('x', '0')}/24 -o eth0 -j MASQUERADE`);
        await Util.exec('iptables -A INPUT -p udp -m udp --dport 51820 -j ACCEPT');
        await Util.exec('iptables -A FORWARD -i wg0 -j ACCEPT');
        await Util.exec('iptables -A FORWARD -o wg0 -j ACCEPT');
        await this.__syncConfig();

        return config;
      });
    }

    return this.__configPromise;
  }

  async saveConfig() {
    const config = await this.getConfig();
    await this.__saveConfig(config);
    await this.__syncConfig();
  }

  async __saveConfig(config) {
    let result = `
# Note: Do not edit this file directly.
# Your changes will be overwritten!

# Server
[Interface]
PrivateKey = ${config.server.privateKey}
Address = ${config.server.address}/24
ListenPort = 51820`;

    for (const [clientId, client] of Object.entries(config.clients)) {
      if (!client.enabled) continue;

      result += `

# Client: ${client.name} (${clientId})
[Peer]
PublicKey = ${client.publicKey}
PresharedKey = ${client.preSharedKey}
AllowedIPs = ${client.address}/32`;
    }

    debug('Saving config...');
    await fs.writeFile(path.join(WG_PATH, 'wg0.json'), JSON.stringify(config, false, 2));
    await fs.writeFile(path.join(WG_PATH, 'wg0.conf'), result);
    debug('Config saved.');
  }

  async __syncConfig() {
    debug('Syncing config...');
    await Util.exec('wg syncconf wg0 <(wg-quick strip wg0)');
    debug('Config synced.');
  }

  async getClients() {
    const config = await this.getConfig();
    const clients = Object.entries(config.clients).map(([clientId, client]) => ({
      id: clientId,
      name: client.name,
      enabled: client.enabled,
      address: client.address,
      publicKey: client.publicKey,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),

      persistentKeepalive: null,
      latestHandshakeAt: null,
      transferRx: null,
      transferTx: null,
      allowedIPs: null,
    }));

    // Loop WireGuard status
    const dump = await Util.exec('wg show wg0 dump', {
      log: false,
    });
    dump
      .trim()
      .split('\n')
      .slice(1)
      .forEach(line => {
        const [
          publicKey,
          preSharedKey, // eslint-disable-line no-unused-vars
          endpoint, // eslint-disable-line no-unused-vars
          allowedIPs,
          latestHandshakeAt,
          transferRx,
          transferTx,
          persistentKeepalive,
        ] = line.split('\t');

        const client = clients.find(client => client.publicKey === publicKey);
        if (!client) return;

        client.latestHandshakeAt = latestHandshakeAt === '0'
          ? null
          : new Date(Number(`${latestHandshakeAt}000`));
        client.transferRx = Number(transferRx);
        client.transferTx = Number(transferTx);
        client.persistentKeepalive = persistentKeepalive;
        client.allowedIPs = allowedIPs;
      });

    return clients;
  }

  async getClient({ clientId }) {
    const config = await this.getConfig();
    const client = config.clients[clientId];
    if (!client) {
      throw new ServerError(`Client Not Found: ${clientId}`, 404);
    }

    return client;
  }

  async getClientConfiguration({ clientId }) {
    const config = await this.getConfig();
    const client = await this.getClient({ clientId });

    return `
[Interface]
PrivateKey = ${client.privateKey}
Address = ${client.address}/24
${WG_DEFAULT_DNS ? `DNS = ${WG_DEFAULT_DNS}` : ''}

[Peer]
PublicKey = ${config.server.publicKey}
PresharedKey = ${client.preSharedKey}
AllowedIPs = ${WG_ALLOWED_IPS}
PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}
Endpoint = ${WG_HOST}:${WG_PORT}`;
  }

  async getClientQRCodeSVG({ clientId }) {
    const config = await this.getClientConfiguration({ clientId });
    return QRCode.toString(config, {
      type: 'svg',
      width: 512,
    });
  }

  async createClient({ name }) {
    if (!name) {
      throw new Error('Missing: Name');
    }

    const config = await this.getConfig();

    const privateKey = await Util.exec('wg genkey');
    const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`);
    const preSharedKey = await Util.exec('wg genpsk');

    // Calculate next IP
    let address;
    for (let i = 2; i < 255; i++) {
      const client = Object.values(config.clients).find(client => {
        return client.address === WG_DEFAULT_ADDRESS.replace('x', i);
      });

      if (!client) {
        address = WG_DEFAULT_ADDRESS.replace('x', i);
        break;
      }
    }

    if (!address) {
      throw new Error('Maximum number of clients reached.');
    }

    // Create Client
    const clientId = uuid.v4();
    const client = {
      name,
      address,
      privateKey,
      publicKey,
      preSharedKey,

      createdAt: new Date(),
      updatedAt: new Date(),

      enabled: true,
    };

    config.clients[clientId] = client;

    await this.saveConfig();
  }

  async deleteClient({ clientId }) {
    const config = await this.getConfig();

    if (config.clients[clientId]) {
      delete config.clients[clientId];
      await this.saveConfig();
    }
  }

  async enableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = true;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async disableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = false;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientName({ clientId, name }) {
    const client = await this.getClient({ clientId });

    client.name = name;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAddress({ clientId, address }) {
    const client = await this.getClient({ clientId });

    if (!Util.isValidIPv4(address)) {
      throw new ServerError(`Invalid Address: ${address}`, 400);
    }

    client.address = address;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

};
