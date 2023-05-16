'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const adapterName = require('./package.json').name.split('.').pop();

class AwtrixLight extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: adapterName,
        });

        this.supportedVersion = '0.62';
        this.displayedVersionWarning = false;

        this.refreshStateTimeout = null;
        this.refreshAppTimeout = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setState('info.connection', { val: false, ack: true });

        await this.subscribeStatesAsync('*');

        this.refreshState();
        this.refreshApps();
    }

    /**
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (id && state && !state.ack) {
            const idNoNamespace = this.removeNamespace(id);

            this.log.debug(`state ${idNoNamespace} changed: ${state.val}`);

            if (idNoNamespace === 'display.power') {
                this.log.debug(`changing display power to ${state.val}`);

                this.buildRequest(
                    'power',
                    async (content) => {
                        if (content === 'OK') {
                            await this.setStateChangedAsync('display.power', { val: state.val, ack: true });
                        }
                    },
                    'POST',
                    {
                        power: state.val,
                    },
                );
            } else if (idNoNamespace === 'apps.next') {
                this.log.debug('switching to next app');

                this.buildRequest('nextapp', null, 'POST', null);
            } else if (idNoNamespace === 'apps.prev') {
                this.log.debug('switching to previous app');

                this.buildRequest('previousapp', null, 'POST', null);
            } else if (idNoNamespace.indexOf('apps.') === 0) {
                if (idNoNamespace.endsWith('.visible')) {
                    const obj = await this.getObjectAsync(idNoNamespace);
                    if (obj && obj.native?.name) {
                        this.buildRequest('apps', null, 'POST', [{ name: obj.native.name, show: state.val }]);
                    }
                } else if (idNoNamespace.endsWith('.activate')) {
                    if (state.val) {
                        const obj = await this.getObjectAsync(idNoNamespace);
                        if (obj && obj.native?.name) {
                            this.buildRequest('switch', null, 'POST', { name: obj.native.name });
                        }
                    }
                }
            }
        }
    }

    /**
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        this.log.debug(`[onMessage] received message: ${JSON.stringify(obj.message)}`);

        if (obj && obj.message) {
            // Notification
            if (obj.command === 'notification' && typeof obj.message === 'object') {
                // Todo
            } else {
                this.log.error(`[onMessage] Received incomplete message via "sendTo"`);

                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'Incomplete message' }, obj.callback);
                }
            }
        } else if (obj.callback) {
            this.sendTo(obj.from, obj.command, { error: 'Invalid message' }, obj.callback);
        }
    }

    refreshState() {
        this.log.debug('refreshing device state');

        this.buildRequest(
            'stats',
            async (content) => {
                await this.setStateAsync('info.connection', { val: true, ack: true });

                if (this.isNewerVersion(content.version, this.supportedVersion) && !this.displayedVersionWarning) {
                    this.log.warn(`You should update your Awtrix Light - supported version of this adapter is ${this.supportedVersion} (or later). Your current version is ${content.version}`);
                    this.displayedVersionWarning = true; // Just show once
                }

                await this.setStateChangedAsync('meta.version', { val: content.version, ack: true });

                await this.setStateChangedAsync('sensor.lux', { val: parseInt(content.lux), ack: true });
                await this.setStateChangedAsync('sensor.temp', { val: parseInt(content.temp), ack: true });
                await this.setStateChangedAsync('sensor.humidity', { val: parseInt(content.hum), ack: true });
            },
            'GET',
            null,
        );

        this.log.debug('re-creating refresh state timeout');
        this.refreshStateTimeout =
            this.refreshStateTimeout ||
            setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState();
            }, 60000);
    }

    refreshApps() {
        this.buildRequest(
            'apps',
            (content) => {
                const appPath = 'apps';

                this.getChannelsOf(appPath, async (err, states) => {
                    const appsAll = [];
                    const appsKeep = [];

                    // Collect all apps
                    if (states) {
                        for (let i = 0; i < states.length; i++) {
                            const id = this.removeNamespace(states[i]._id);

                            // Check if the state is a direct child (e.g. apps.08b8eac21074f8f7e5a29f2855ba8060)
                            if (id.split('.').length === 2) {
                                appsAll.push(id);
                            }
                        }
                    }

                    // Create new app structure
                    for (const app of content) {
                        const name = app.name;

                        appsKeep.push(`${appPath}.${name}`);
                        this.log.debug(`[apps] found (keep): ${appPath}.${name}`);

                        await this.setObjectNotExistsAsync(`${appPath}.${name}`, {
                            type: 'channel',
                            common: {
                                name: `App ${name}`,
                            },
                            native: {},
                        });

                        await this.setObjectNotExistsAsync(`${appPath}.${name}.activate`, {
                            type: 'state',
                            common: {
                                name: {
                                    en: 'Activate',
                                    de: 'Aktivieren',
                                    ru: 'Активировать',
                                    pt: 'Ativar',
                                    nl: 'Activeren',
                                    fr: 'Activer',
                                    it: 'Attivare',
                                    es: 'Activar',
                                    pl: 'Aktywuj',
                                    'zh-cn': '启用',
                                },
                                type: 'boolean',
                                role: 'button',
                                read: false,
                                write: true,
                            },
                            native: {
                                name,
                            },
                        });

                        await this.setObjectNotExistsAsync(`${appPath}.${name}.visible`, {
                            type: 'state',
                            common: {
                                name: {
                                    en: 'Visible',
                                    de: 'Sichtbar',
                                    ru: 'Видимый',
                                    pt: 'Visível',
                                    nl: 'Vertaling:',
                                    fr: 'Visible',
                                    it: 'Visibile',
                                    es: 'Visible',
                                    pl: 'Widoczny',
                                    uk: 'Вибрані',
                                    'zh-cn': '不可抗辩',
                                },
                                type: 'boolean',
                                role: 'indicator',
                                read: true,
                                write: true,
                                def: true,
                            },
                            native: {
                                name,
                            },
                        });
                        //await this.setStateChangedAsync(`${appPath}.${name}.visible`, { val: widget.visible, ack: true });
                    }

                    // Delete non existent apps
                    for (let i = 0; i < appsAll.length; i++) {
                        const id = appsAll[i];

                        if (appsKeep.indexOf(id) === -1) {
                            await this.delObjectAsync(id, { recursive: true });
                            this.log.debug(`[apps] deleted: ${id}`);
                        }
                    }
                });
            },
            'GET',
            null,
        );

        this.log.debug('[apps] re-creating refresh timeout');
        this.refreshAppTimeout =
            this.refreshAppTimeout ||
            setTimeout(() => {
                this.refreshAppTimeout = null;
                this.refreshApps();
            }, 60000 * 60);
    }

    buildRequest(service, callback, method, data) {
        const url = `/api/${service}`;

        if (this.config.awtrixIp) {
            this.log.debug(`sending "${method}" request to "${url}" with data: ${JSON.stringify(data)}`);

            axios({
                method: method,
                data: data,
                baseURL: `http://${this.config.awtrixIp}:80`,
                url: url,
                timeout: 3000,
                responseType: 'json',
            })
                .then((response) => {
                    this.log.debug(`received ${response.status} response from "${url}" with content: ${JSON.stringify(response.data)}`);

                    if (response && callback && typeof callback === 'function') {
                        callback(response.data, response.status);
                    }
                })
                .catch((error) => {
                    if (error.response) {
                        // The request was made and the server responded with a status code

                        this.log.warn(`received error ${error.response.status} response from "${url}" with content: ${JSON.stringify(error.response.data)}`);
                    } else if (error.request) {
                        // The request was made but no response was received
                        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                        // http.ClientRequest in node.js
                        this.log.info(error.message);

                        this.setStateAsync('info.connection', { val: false, ack: true });
                    } else {
                        // Something happened in setting up the request that triggered an Error
                        this.log.error(error.message);

                        this.setStateAsync('info.connection', { val: false, ack: true });
                    }
                });
        }
    }

    removeNamespace(id) {
        const re = new RegExp(this.namespace + '*\\.', 'g');
        return id.replace(re, '');
    }

    /**
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setStateAsync('info.connection', { val: false, ack: true });

            if (this.refreshStateTimeout) {
                this.log.debug('clearing refresh state timeout');
                clearTimeout(this.refreshStateTimeout);
            }

            if (this.refreshAppTimeout) {
                this.log.debug('clearing refresh app timeout');
                clearTimeout(this.refreshAppTimeout);
            }

            callback();
        } catch (e) {
            callback();
        }
    }

    isNewerVersion(oldVer, newVer) {
        const oldParts = oldVer.split('.');
        const newParts = newVer.split('.');
        for (let i = 0; i < newParts.length; i++) {
            const a = ~~newParts[i]; // parse int
            const b = ~~oldParts[i]; // parse int
            if (a > b) return true;
            if (a < b) return false;
        }
        return false;
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new AwtrixLight(options);
} else {
    // otherwise start the instance directly
    new AwtrixLight();
}
