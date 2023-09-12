/*
 * Created with @iobroker/create-adapter v2.5.0
 */

import * as utils from '@iobroker/adapter-core';

import axios, { AxiosResponse } from 'axios';
import { CustomApp } from './lib/adapter-config';
import { rgb565to888Str, rgb565to888StrSvg } from './lib/color-convert';

const NATIVE_APPS = ['time', 'date', 'temp', 'hum', 'bat'];

namespace Awtrix {
    export type App = {
        text?: string;
        textCase?: number;
        topText?: boolean;
        textOffset?: number;
        center?: boolean;
        color?: string;
        gradient?: string;
        blinkText?: number;
        fadeText?: number;
        background?: string;
        rainbow?: boolean;
        icon?: string;
        pushIcon?: number;
        repeat?: number;
        duration?: number;
        bar?: Array<number>;
        line?: Array<number>;
        autoscale?: boolean;
        progress?: number;
        progressC?: string;
        progressBC?: string;
        pos?: number;
        draw?: Array<object>;
        lifetime?: number;
        lifetimeMode?: number;
        noScroll?: boolean;
        scrollSpeed?: number;
        effect?: string;
        effectSettings?: Array<object>;
        save?: boolean;
    }

    export type Indicator = {
        color?: string;
        blink?: number;
    }

    export type Moodlight = {
        brightness?: number;
        color?: string;
    }
}

class AwtrixLight extends utils.Adapter {
    supportedVersion: string;
    displayedVersionWarning: boolean;

    apiConnected: boolean;
    refreshStateTimeout: void | NodeJS.Timeout | null;
    refreshHistoryAppsTimeout: void | NodeJS.Timeout | null;
    downloadScreenContentInterval: void | NodeJS.Timeout | null;

    customAppsForeignStates: { [key: string]: { val: string | ioBroker.StateValue | undefined; unit: any; type: string; ts: number; }};

    backgroundEffects: Array<string>;

    lastErrorCode: number;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'awtrix-light',
            useFormatDate: true,
        });

        this.supportedVersion = '0.86';
        this.displayedVersionWarning = false;

        this.apiConnected = false;

        this.refreshStateTimeout = null;
        this.refreshHistoryAppsTimeout = null;
        this.downloadScreenContentInterval = null;

        this.customAppsForeignStates = {};

        this.backgroundEffects = [
            'Fade',
            'MovingLine',
            'BrickBreaker',
            'PingPong',
            'Radar',
            'Checkerboard',
            'Fireworks',
            'PlasmaCloud',
            'Ripple',
            'Snake',
            'Pacifica',
            'TheaterChase',
            'Plasma',
            'Matrix',
            'SwirlIn',
            'SwirlOut',
            'LookingEyes',
            'TwinklingStars',
            'ColorWaves',
        ];

        this.lastErrorCode = -1;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        this.setApiConnected(false);

        await this.upgradeFromPreviousVersion();
        await this.subscribeStatesAsync('*');

        if (!this.config.awtrixIp) {
            this.log.error(`IP address not configured - please check instance configuration and restart`);
            return;
        } else {
            this.log.info(`Starting - connecting to http://${this.config.awtrixIp}/`);
        }

        if (this.config.foreignSettingsInstance && this.config.foreignSettingsInstance !== this.namespace) {
            await this.subscribeForeignObjectsAsync(`system.adapter.${this.config.foreignSettingsInstance}`);
            await this.importForeignSettings();
        }

        // Apply positions of instance configuration
        if (!this.config.customPositions) {
            this.log.debug(`[onReady] Setting position of each app as ordered in instance configuration (custom positions are disabled)`);

            let pos = 0;
            for (const customApp of this.config.customApps) {
                customApp.position = pos++;
            }

            for (const historyApp of this.config.historyApps) {
                historyApp.position = pos++;
            }

            for (const expertApp of this.config.expertApps) {
                expertApp.position = pos++;
            }
        } else {
            this.log.debug(`[onReady] Custom positions are enabled - using app positions of instance configuration`);
        }

        this.refreshState();
    }

    private async upgradeFromPreviousVersion(): Promise<void> {
        this.log.debug(`Upgrading objects from previous version`);

        await this.delObjectAsync('apps.eyes', { recursive: true }); // eyes app was removed in firmware 0.71
    }

    private async importForeignSettings(): Promise<void> {
        try {
            this.log.info(`Using settings of other instance: ${this.config.foreignSettingsInstance}`);

            const instanceObj = await this.getForeignObjectAsync(`system.adapter.${this.config.foreignSettingsInstance}`);

            if (instanceObj && instanceObj.native) {
                if (!instanceObj.native?.foreignSettingsInstance) {
                    this.config.customApps = instanceObj.native.customApps;
                    this.config.ignoreNewValueForAppInTimeRange = instanceObj.native.ignoreNewValueForAppInTimeRange;
                    this.config.historyApps = instanceObj.native.historyApps;
                    this.config.historyAppsRefreshInterval = instanceObj.native.historyAppsRefreshInterval;
                    this.config.autoDeleteForeignApps = instanceObj.native.autoDeleteForeignApps;
                    this.config.removeAppsOnStop = instanceObj.native.removeAppsOnStop;
                    this.config.expertApps = instanceObj.native.expertApps;

                    this.log.debug(`[importForeignSettings] Copied settings from foreign instance "system.adapter.${this.config.foreignSettingsInstance}"`);
                } else {
                    throw new Error(`Foreign instance uses instance settings of ${instanceObj?.native?.foreignSettingsInstance} - (nothing imported)`);
                }
            } else {
                throw new Error(`Unable to load instance settings of ${instanceObj?.native?.foreignSettingsInstance} (nothing imported)`);
            }
        } catch (err) {
            this.log.error(`Unable to import settings of other instance: ${err}`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (id && state && Object.prototype.hasOwnProperty.call(this.customAppsForeignStates, id)) {
            if (state.ack) {
                // Just refresh if value has changed
                if (state.val !== this.customAppsForeignStates[id].val) {
                    this.log.debug(`[onStateChange] received state change of objId "${id}" from ${this.customAppsForeignStates[id].val} to ${state.val} (ts: ${state.ts})`);

                    if (this.customAppsForeignStates[id].ts + this.config.ignoreNewValueForAppInTimeRange * 1000 < state.ts) {
                        this.customAppsForeignStates[id].val = this.customAppsForeignStates[id].type === 'mixed' ? String(state.val) : state.val;
                        this.customAppsForeignStates[id].ts = state.ts;

                        this.refreshCustomApps(id);
                    } else {
                        this.log.debug(
                            `[onStateChange] ignoring customApps state change of objId "${id}" to ${state.val} - refreshes too fast (within ${
                                this.config.ignoreNewValueForAppInTimeRange
                            } seconds) - Last update: ${this.formatDate(this.customAppsForeignStates[id].ts, 'YYYY-MM-DD hh:mm:ss.sss')}`,
                        );
                    }
                }
            } else {
                this.log.debug(`[onStateChange] ignoring customApps state change of "${id}" to ${state.val} - ack is false`);
            }
        }

        if (id && state && !state.ack) {
            const idNoNamespace = this.removeNamespace(id);

            this.log.debug(`state ${idNoNamespace} changed: ${state.val}`);

            if (this.apiConnected) {
                if (idNoNamespace.startsWith('settings.')) {
                    this.log.debug(`changing setting ${idNoNamespace} power to ${state.val}`);

                    const settingsObj = await this.getObjectAsync(idNoNamespace);
                    if (settingsObj && settingsObj.native?.settingsKey) {
                        this.buildRequestAsync('settings', 'POST', { [settingsObj.native.settingsKey]: state.val })
                            .then(async (response) => {
                                if (response.status === 200 && response.data === 'OK') {
                                    await this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                }

                                await this.refreshSettings();
                            })
                            .catch((error) => {
                                this.log.warn(`(settings) Unable to execute action: ${error}`);
                            });
                    } else {
                        this.log.warn(`Unable to change setting of ${id} - settingsKey not found`);
                    }
                } else if (idNoNamespace === 'display.power') {
                    this.log.debug(`changing display power to ${state.val}`);

                    this.buildRequestAsync('power', 'POST', { power: state.val })
                        .then(async (response) => {
                            if (response.status === 200 && response.data === 'OK') {
                                await this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                            }
                        })
                        .catch((error) => {
                            this.log.warn(`(power) Unable to execute action: ${error}`);
                        });
                } else if (idNoNamespace.startsWith('display.moodlight.')) {
                    this.updateMoodlightByStates()
                        .then(async (response) => {
                            if (response.status === 200 && response.data === 'OK') {
                                await this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                            }
                        })
                        .catch((error) => {
                            this.log.warn(`(moodlight) Unable to execute action: ${error}`);
                        });
                } else if (idNoNamespace === 'device.update') {
                    this.log.info('performing firmware update');

                    this.buildRequestAsync('doupdate', 'POST')
                        .then(async (response) => {
                            if (response.status === 200 && response.data === 'OK') {
                                this.log.info('started firmware update');
                            }
                        })
                        .catch((error) => {
                            this.log.warn(`(doupdate) Unable to execute firmware update (maybe this is already the newest version): ${error}`);
                        });
                } else if (idNoNamespace === 'device.reboot') {
                    this.buildRequestAsync('reboot', 'POST')
                        .then(async (response) => {
                            if (response.status === 200 && response.data === 'OK') {
                                this.log.info('rebooting device');
                                this.setApiConnected(false);
                            }
                        })
                        .catch((error) => {
                            this.log.warn(`(reboot) Unable to execute action: ${error}`);
                        });
                } else if (idNoNamespace === 'apps.next') {
                    this.log.debug('switching to next app');

                    this.buildRequestAsync('nextapp', 'POST').catch((error) => {
                        this.log.warn(`(nextapp) Unable to execute action: ${error}`);
                    });
                } else if (idNoNamespace === 'apps.prev') {
                    this.log.debug('switching to previous app');

                    this.buildRequestAsync('previousapp', 'POST').catch((error) => {
                        this.log.warn(`(previousapp) Unable to execute action: ${error}`);
                    });
                } else if (idNoNamespace.startsWith('apps.')) {
                    if (idNoNamespace.endsWith('.activate')) {
                        if (state.val) {
                            const sourceObj = await this.getObjectAsync(idNoNamespace);
                            if (sourceObj && sourceObj.native?.name) {
                                this.log.debug(`activating app ${sourceObj.native.name}`);

                                this.buildRequestAsync('switch', 'POST', { name: sourceObj.native.name }).catch((error) => {
                                    this.log.warn(`(switch) Unable to execute action: ${error}`);
                                });
                            }
                        } else {
                            this.log.warn(`Received invalid value for state ${idNoNamespace}`);
                        }
                    } else if (idNoNamespace.endsWith('.visible')) {
                        const sourceObj = await this.getObjectAsync(idNoNamespace);
                        if (sourceObj && sourceObj.native?.name) {
                            this.log.debug(`changing visibility of app ${sourceObj.native.name} to ${state.val}`);

                            await this.setStateAsync(idNoNamespace, { val: state.val, ack: true, c: 'onStateChange' });

                            // ToDo: Just update a single app
                            await this.initAllApps();
                        }
                    } else {
                        // Expert apps
                        await this.initExpertApps();
                    }
                } else if (idNoNamespace.match(/indicator\.[0-9]{1}\..*$/g)) {
                    const matches = idNoNamespace.match(/indicator\.([0-9]{1})\.(.*)$/);
                    const indicatorNo = matches ? parseInt(matches[1]) : undefined;
                    const action = matches ? matches[2] : undefined;

                    this.log.debug(`Changed indicator ${indicatorNo} with action ${action}`);

                    if (indicatorNo && indicatorNo >= 1) {
                        this.updateIndicatorByStates(indicatorNo)
                            .then(async (response) => {
                                if (response.status === 200 && response.data === 'OK') {
                                    await this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                }
                            })
                            .catch((error) => {
                                this.log.warn(`(indicator) Unable to perform action: ${error}`);
                            });
                    }
                }
            } else {
                this.log.warn(`Unable to perform action for ${idNoNamespace} - API is not connected (device not reachable?)`);
            }
        }
    }

    private async onObjectChange(id: string, obj: ioBroker.Object | null | undefined): Promise<void> {
        // Imported settings changed
        if (id && id == `system.adapter.${this.config.foreignSettingsInstance}`) {
            await this.importForeignSettings();

            // Refresh apps (may have changed)
            if (this.apiConnected) {
                await this.createAppObjects();
                await this.initAllApps();
            }
        }

        if (id && Object.prototype.hasOwnProperty.call(this.customAppsForeignStates, id)) {
            if (!obj) {
                delete this.customAppsForeignStates[id];
            } else {
                this.customAppsForeignStates[id].type = obj?.common.type;
                this.customAppsForeignStates[id].unit = obj?.common?.unit;

                this.refreshCustomApps(id);
            }
        }
    }

    private onMessage(obj: ioBroker.Message): void {
        this.log.debug(`[onMessage] received command "${obj.command}" with message: ${JSON.stringify(obj.message)}`);

        if (obj && obj.message) {
            if (obj.command === 'getBackgroundEffects') {
                this.sendTo(
                    obj.from,
                    obj.command,
                    this.backgroundEffects.map((v) => ({ value: v, label: v })),
                    obj.callback,
                );
            } else if (obj.command === 'notification' && typeof obj.message === 'object') {
                // Notification
                if (this.apiConnected) {
                    const msgFiltered: Awtrix.App = Object.fromEntries(Object.entries(obj.message).filter(([_, v]) => v !== null)); // eslint-disable-line no-unused-vars

                    // Remove repeat if <= 0
                    if (msgFiltered.repeat !== undefined && msgFiltered.repeat <= 0) {
                        delete msgFiltered.repeat;
                    }

                    // Remove duration if <= 0
                    if (msgFiltered.duration !== undefined && msgFiltered.duration <= 0) {
                        delete msgFiltered.duration;
                    }

                    this.buildRequestAsync('notify', 'POST', msgFiltered)
                        .then((response) => {
                            this.sendTo(obj.from, obj.command, { error: null, data: response.data }, obj.callback);
                        })
                        .catch((error) => {
                            this.sendTo(obj.from, obj.command, { error }, obj.callback);
                        });
                } else {
                    this.sendTo(obj.from, obj.command, { error: 'API is not connected (device offline ?)' }, obj.callback);
                }
            } else if (obj.command === 'sound' && typeof obj.message === 'object') {
                // Sound
                if (this.apiConnected) {
                    const msgFiltered = Object.fromEntries(Object.entries(obj.message).filter(([_, v]) => v !== null)); // eslint-disable-line no-unused-vars

                    this.buildRequestAsync('sound', 'POST', msgFiltered)
                        .then((response) => {
                            this.sendTo(obj.from, obj.command, { error: null, data: response.data }, obj.callback);
                        })
                        .catch((error) => {
                            this.sendTo(obj.from, obj.command, { error }, obj.callback);
                        });
                } else {
                    this.sendTo(obj.from, obj.command, { error: 'API is not connected (device offline ?)' }, obj.callback);
                }
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

    private async setApiConnected(connection: boolean): Promise<void> {
        if (connection !== this.apiConnected) {
            await this.setStateChangedAsync('info.connection', { val: connection, ack: true });
            this.apiConnected = connection;

            if (connection) {
                // API was offline - refresh all states
                this.log.debug('API is online');

                try {
                    // settings
                    await this.refreshSettings();
                    await this.refreshBackgroundEffects();
                    await this.refreshTransitions();

                    // apps
                    await this.createAppObjects();
                    await this.initAllApps();

                    // Subscribe to all states
                    await this.subscribeForeignStatesAsync(Object.keys(this.customAppsForeignStates));

                    // indicators
                    for (let i = 1; i <= 3; i++) {
                        await this.updateIndicatorByStates(i);
                    }

                    // moodlight
                    await this.updateMoodlightByStates();

                    // welcome (ioBroker icon)
                    this.buildRequestAsync('notify', 'POST', {
                        duration: 2,
                        draw: [
                            {
                                dc: [16, 4, 3, '#164477'], // [x, y, r, cl] Draw a circle with center at (x, y), radius r, and color cl
                                dl: [16, 3, 16, 8, '#3399cc'], // [x0, y0, x1, y1, cl] Draw a line from (x0, y0) to (x1, y1) with color cl
                                dp: [16, 1, '#3399cc'], // [x, y, cl] Draw a pixel at position (x, y) with color cl
                            },
                        ],
                    }).catch((error) => {
                        this.log.warn(error);
                    });

                    if (this.config.downloadScreenContent && !this.downloadScreenContentInterval) {
                        this.log.debug(`[setApiConnected] Downloading screen contents every ${this.config.downloadScreenContentInterval} seconds`);

                        this.downloadScreenContentInterval = this.setInterval(() => {
                            if (this.apiConnected) {
                                this.buildRequestAsync('screen', 'GET')
                                    .then(async (response) => {
                                        if (response.status === 200) {
                                            const pixelData = response.data;
                                            const width = 640;
                                            const height = 160;
                                            const scaleX = width / 32;
                                            const scaleY = height / 8;

                                            let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 640 160">`;

                                            for (let y = 0; y < 8; y++) {
                                                for (let x = 0; x < 32; x++) {
                                                    const color = rgb565to888StrSvg(pixelData[y * 32 + x]);
                                                    svg += `\n  <rect style="fill: ${color}; stroke: #000000; stroke-width: 2px;" `;
                                                    svg += `x="${x * scaleX}" y="${y * scaleY}" width="${scaleX}" height="${scaleY}"/>`;
                                                }
                                            }

                                            svg += '\n</svg>';

                                            await this.setStateAsync('display.content', { val: svg, ack: true });
                                        }
                                    })
                                    .catch((error) => {
                                        this.log.debug(`(screen) received error: ${JSON.stringify(error)}`);
                                    });
                            }
                        }, this.config.downloadScreenContentInterval * 1000);
                    } else {
                        await this.setStateAsync('display.content', { val: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"/>`, ack: true, c: 'Feature disabled', q: 0x01 });
                    }
                } catch (error) {
                    this.log.error(`[setApiConnected] Unable to refresh settings, apps or indicators: ${error}`);
                }
            } else {
                if (this.downloadScreenContentInterval) {
                    this.clearInterval(this.downloadScreenContentInterval);
                    this.downloadScreenContentInterval = null;
                }

                // Unsubscribe from all states to avoid errors
                await this.unsubscribeForeignStatesAsync(Object.keys(this.customAppsForeignStates));

                this.log.debug('API is offline');
            }
        }
    }

    private refreshState(): void {
        this.log.debug('refreshing device state');

        this.buildRequestAsync('stats', 'GET')
            .then(async (response) => {
                if (response.status === 200) {
                    const content = response.data;

                    this.setApiConnected(true);

                    if (this.isNewerVersion(content.version, this.supportedVersion) && !this.displayedVersionWarning) {
                        this.log.warn(`You should update your Awtrix Light - supported version of this adapter is ${this.supportedVersion} (or later). Your current version is ${content.version}`);
                        this.displayedVersionWarning = true; // Just show once
                    }

                    await this.setStateChangedAsync('meta.version', { val: content.version, ack: true });

                    await this.setStateChangedAsync('sensor.lux', { val: parseInt(content.lux), ack: true });
                    await this.setStateChangedAsync('sensor.temp', { val: parseInt(content.temp), ack: true });
                    await this.setStateChangedAsync('sensor.humidity', { val: parseInt(content.hum), ack: true });

                    await this.setStateChangedAsync('display.brightness', { val: content.bri, ack: true });

                    await this.setStateChangedAsync('device.battery', { val: content.bat, ack: true });
                    await this.setStateChangedAsync('device.wifiSignal', { val: content.wifi_signal, ack: true });
                    await this.setStateChangedAsync('device.freeRAM', { val: content.ram, ack: true });
                    await this.setStateChangedAsync('device.uptime', { val: parseInt(content.uptime), ack: true });
                }
            })
            .catch((error) => {
                this.log.debug(`(stats) received error - API is now offline: ${JSON.stringify(error)}`);
                this.setApiConnected(false);
            });

        this.log.debug('re-creating refresh state timeout');
        this.refreshStateTimeout =
            this.refreshStateTimeout ||
            this.setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState();
            }, 60000);
    }

    private async refreshSettings(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            this.buildRequestAsync('settings', 'GET')
                .then(async (response) => {
                    if (response.status === 200) {
                        const content = response.data;

                        const settingsStates = await this.getObjectViewAsync('system', 'state', {
                            startkey: `${this.namespace}.settings.`,
                            endkey: `${this.namespace}.settings.\u9999`,
                        });

                        // Find all available settings objects with settingsKey
                        const knownSettings: { [key: string]: { id: string; role: string } } = {};
                        for (const settingsObj of settingsStates.rows) {
                            if (settingsObj.value?.native?.settingsKey) {
                                knownSettings[this.removeNamespace(settingsObj.value?.native?.settingsKey)] = {
                                    id: settingsObj.id,
                                    role: settingsObj.value.common.role,
                                };
                            }
                        }

                        for (const [settingsKey, val] of Object.entries(content)) {
                            if (Object.prototype.hasOwnProperty.call(knownSettings, settingsKey)) {
                                if (knownSettings[settingsKey].role === 'level.color.rgb') {
                                    const newVal = rgb565to888Str(val as number);
                                    this.log.debug(`[refreshSettings] updating settings value "${knownSettings[settingsKey].id}" to ${newVal} (converted from ${val})`);

                                    await this.setStateChangedAsync(knownSettings[settingsKey].id, { val: newVal, ack: true, c: 'Updated from API (converted from RGB565)' });
                                } else {
                                    this.log.debug(`[refreshSettings] updating settings value "${knownSettings[settingsKey].id}" to ${val}`);

                                    await this.setStateChangedAsync(knownSettings[settingsKey].id, { val: val as string | number, ack: true, c: 'Updated from API' });
                                }
                            }
                        }
                    }

                    resolve(response.status);
                })
                .catch((error) => {
                    this.log.warn(`(settings) Received error: ${JSON.stringify(error)}`);

                    reject(error);
                });
        });
    }

    private async refreshBackgroundEffects(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this.buildRequestAsync('effects')
                .then((response) => {
                    if (response.status === 200) {
                        this.log.debug(`[refreshBackgroundEffects] Existing effects "${JSON.stringify(response.data)}"`);

                        this.backgroundEffects = response.data;

                        resolve(true);
                    } else {
                        reject(`${response.status}: ${response.data}`);
                    }
                })
                .catch(reject);
        });
    }

    private async refreshTransitions(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.buildRequestAsync('transitions')
                .then((response) => {
                    if (response.status === 200) {
                        this.log.debug(`[refreshTransitions] Existing transitions "${JSON.stringify(response.data)}"`);

                        const states: { [key: string]: string } = {};
                        for (let i = 0; i < response.data.length; i++) {
                            states[i] = response.data[i];
                        }

                        this.extendObjectAsync('settings.appTransitionEffect', {
                            common: {
                                states,
                            },
                        }).then(() => {
                            resolve();
                        });
                    } else {
                        reject(`${response.status}: ${response.data}`);
                    }
                })
                .catch(reject);
        });
    }

    private async removeApp(name: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            if (this.apiConnected) {
                this.buildAppRequestAsync(name)
                    .then((response) => {
                        if (response.status === 200 && response.data === 'OK') {
                            this.log.debug(`[removeApp] Removed customApp app "${name}"`);
                            resolve(true);
                        } else {
                            reject(`${response.status}: ${response.data}`);
                        }
                    })
                    .catch(reject);
            } else {
                reject('API not connected');
            }
        });
    }

    private async initAllApps(): Promise<void> {
        await this.initCustomApps();
        await this.initHistoryApps();
        await this.initExpertApps();
    }

    private async initCustomApps(): Promise<void> {
        if (this.apiConnected) {
            for (const customApp of this.config.customApps) {
                if (customApp.name) {
                    const text = String(customApp.text).trim();
                    const appVisibleState = await this.getStateAsync(`apps.${customApp.name}.visible`);
                    const appVisible = appVisibleState ? appVisibleState.val : true;

                    // Ack if changed while instance was stopped
                    if (appVisibleState && !appVisibleState?.ack) {
                        await this.setStateAsync(`apps.${customApp.name}.visible`, { val: appVisible, ack: true, c: 'initCustomApps' });
                    }

                    if (!appVisible) {
                        this.log.debug(`[initCustomApps] Going to remove custom app "${customApp.name}" (was hidden by state: apps.${customApp.name}.visible)`);

                        await this.removeApp(customApp.name).catch((error) => {
                            this.log.warn(`Unable to remove customApp app "${customApp.name}" (hidden by state): ${error}`);
                        });
                    } else if (customApp.objId && text.includes('%s')) {
                        try {
                            const objId = customApp.objId;
                            if (!Object.prototype.hasOwnProperty.call(this.customAppsForeignStates, objId)) {
                                const obj = await this.getForeignObjectAsync(objId);
                                if (obj && obj.type === 'state') {
                                    const state = await this.getForeignStateAsync(objId);

                                    this.customAppsForeignStates[objId] = {
                                        val: state && state.ack ? state.val : undefined,
                                        type: obj?.common.type,
                                        unit: obj?.common?.unit,
                                        ts: state ? state.ts : Date.now(),
                                    };

                                    const supportedTypes = ['string', 'number', 'mixed'];
                                    if (obj?.common.type && !supportedTypes.includes(obj.common.type)) {
                                        this.log.warn(
                                            `[initCustomApps] Object of app "${customApp.name}" with objId "${objId}" has invalid type: ${obj.common.type} instead of ${supportedTypes.join(', ')}`,
                                        );
                                    }

                                    if (text.includes('%u') && !obj?.common?.unit) {
                                        this.log.warn(
                                            `[initCustomApps] Object of custom app "${customApp.name}" (${objId}) has no unit - remove "%u" from text or define unit in object (common.unit)`,
                                        );
                                    }

                                    if (state && !state.ack) {
                                        this.log.info(`[initCustomApps] State value of custom app "${customApp.name}" (${objId}) is not acknowledged (ack: false) - waiting for new value`);
                                    }

                                    await this.subscribeForeignStatesAsync(objId);
                                    await this.subscribeForeignObjectsAsync(objId);

                                    this.log.debug(`[initCustomApps] Found custom app "${customApp.name}" with objId "${objId}" - subscribed to changes`);
                                } else {
                                    this.log.warn(`[initCustomApps] Custom app "${customApp.name}" was configured with invalid objId "${objId}": Invalid type ${obj?.type}`);
                                }
                            } else {
                                this.log.debug(`[initCustomApps] Found custom app "${customApp.name}" with objId "${objId}" - already subscribed to changes`);
                            }
                        } catch (error) {
                            this.log.error(`[initCustomApps] Unable to get object information for custom app "${customApp.name}": ${error}`);
                        }
                    } else if (text.length > 0) {
                        // App with static text (no %s specified)
                        this.log.debug(`[initCustomApps] Creating custom app "${customApp.name}" with icon "${customApp.icon}" and static text "${customApp.text}"`);

                        if (customApp.objId) {
                            this.log.warn(
                                `[initCustomApps] Custom app "${customApp.name}" was defined with objId "${customApp.objId}" but "%s" is not used in the text - state changes will be ignored`,
                            );
                        }

                        const displayText = text.replace('%u', '').trim();

                        if (displayText.length > 0) {
                            await this.buildAppRequestAsync(customApp.name, this.createAppRequestObj(customApp, displayText)).catch((error) => {
                                this.log.warn(`(custom?name=${customApp.name}) Unable to create custom app "${customApp.name}" with static text: ${error}`);
                            });
                        } else {
                            // Empty text => remove app
                            this.log.debug(`[initCustomApps] Going to remove custom app "${customApp.name}" with static text (empty text)`);

                            await this.removeApp(customApp.name).catch((error) => {
                                this.log.warn(`Unable to remove customApp app "${customApp.name}" with static text (empty text): ${error}`);
                            });
                        }
                    }
                } else {
                    this.log.warn(`[initCustomApps] Found custom app without name (skipped) - please check instance configuartion`);
                }
            }

            // Trigger update for all found objIds
            for (const objId of Object.keys(this.customAppsForeignStates)) {
                await this.refreshCustomApps(objId);
            }
        }
    }

    private async refreshCustomApps(objId: string): Promise<void> {
        if (this.apiConnected && Object.prototype.hasOwnProperty.call(this.customAppsForeignStates, objId)) {
            this.log.debug(`[refreshCustomApps] Refreshing custom apps for objId "${objId}" with data ${JSON.stringify(this.customAppsForeignStates[objId])}`);

            for (const customApp of this.config.customApps) {
                if (customApp.name) {
                    const text = String(customApp.text).trim();

                    if (customApp.objId && customApp.objId === objId && text.includes('%s')) {
                        this.log.debug(`[refreshCustomApps] Refreshing custom app "${customApp.name}" with icon "${customApp.icon}" and text "${customApp.text}"`);

                        try {
                            const appVisibleState = await this.getStateAsync(`apps.${customApp.name}.visible`);
                            const appVisible = appVisibleState ? appVisibleState.val : true;

                            if (appVisible) {
                                const val = this.customAppsForeignStates[objId].val;

                                if (typeof val !== 'undefined') {
                                    let newVal = val;

                                    if (this.customAppsForeignStates[objId].type === 'number') {
                                        const oldVal = typeof val !== 'number' ? parseFloat(val as string) : val;
                                        const decimals = typeof customApp.decimals === 'string' ? parseInt(customApp.decimals) : customApp.decimals ?? 3;

                                        if (!isNaN(oldVal) && oldVal % 1 !== 0) {
                                            let countDecimals = String(val).split('.')[1].length || 2;

                                            if (countDecimals > decimals) {
                                                countDecimals = decimals; // limit
                                            }

                                            const numFormat = this.config.numberFormat;
                                            if (numFormat === 'system') {
                                                newVal = this.formatValue(oldVal, countDecimals);
                                            } else if (['.,', ',.'].includes(numFormat)) {
                                                newVal = this.formatValue(oldVal, countDecimals, numFormat);
                                            } else if (numFormat === '.') {
                                                newVal = oldVal.toFixed(countDecimals);
                                            } else if (numFormat === ',') {
                                                newVal = oldVal.toFixed(countDecimals).replace('.', ',');
                                            }

                                            this.log.debug(`[refreshCustomApps] formatted value of objId "${objId}" from ${oldVal} to ${newVal} (${countDecimals} decimals) with "${numFormat}"`);
                                        }
                                    }

                                    const displayText = text
                                        .replace('%s', newVal as string)
                                        .replace('%u', this.customAppsForeignStates[objId].unit ?? '')
                                        .trim();

                                    if (displayText.length > 0) {
                                        await this.buildAppRequestAsync(customApp.name, this.createAppRequestObj(customApp, displayText, val)).catch((error) => {
                                            this.log.warn(`(custom?name=${customApp.name}) Unable to update custom app "${customApp.name}": ${error}`);
                                        });
                                    } else {
                                        // Empty text => remove app
                                        this.log.debug(`[refreshCustomApps] Going to remove custom app "${customApp.name}" (empty text)`);

                                        await this.removeApp(customApp.name).catch((error) => {
                                            this.log.warn(`Unable to remove customApp app "${customApp.name}" (empty text): ${error}`);
                                        });
                                    }
                                } else {
                                    // No state value => remove app
                                    this.log.debug(`[refreshCustomApps] Going to remove custom app "${customApp.name}" (no state data)`);

                                    await this.removeApp(customApp.name).catch((error) => {
                                        this.log.warn(`Unable to remove customApp app "${customApp.name}" (no state data): ${error}`);
                                    });
                                }
                            }
                        } catch (error) {
                            this.log.error(`[refreshCustomApps] Unable to refresh custom app "${customApp.name}": ${error}`);
                        }
                    }
                }
            }
        }
    }

    private createAppRequestObj(customApp: CustomApp, text: string, val?: ioBroker.StateValue): Awtrix.App {
        const moreOptions: Awtrix.App = {};

        // Background
        if (customApp.useBackgroundEffect) {
            moreOptions.effect = customApp.backgroundEffect;
        } else if (customApp.backgroundColor) {
            moreOptions.background = customApp.backgroundColor;
        }

        // Set rainbow colors OR text color
        if (customApp.rainbow) {
            moreOptions.rainbow = true;
        } else if (customApp.textColor) {
            moreOptions.color = customApp.textColor;
        }

        // Set noScroll OR scroll speed
        if (customApp.noScroll) {
            moreOptions.noScroll = true;
        } else {
            // Scroll speed
            if (customApp.scrollSpeed > 0) {
                moreOptions.scrollSpeed = customApp.scrollSpeed;
            }

            // Repeat
            if (customApp.repeat > 0) {
                moreOptions.repeat = customApp.repeat;
            }
        }

        // Icon
        if (customApp.icon) {
            moreOptions.icon = customApp.icon;
        }

        // Duration
        if (customApp.duration > 0) {
            moreOptions.duration = customApp.duration;
        }

        // Thresholds
        if (typeof val === 'number') {
            if (customApp.thresholdLtActive && val < customApp.thresholdLtValue) {
                this.log.debug(`[createAppRequestObj] LT < custom app "${customApp.name}" has a value (${val}) less than ${customApp.thresholdLtValue} - overriding values`);

                if (customApp.thresholdLtIcon) {
                    moreOptions.icon = customApp.thresholdLtIcon;
                }
                if (customApp.thresholdLtTextColor) {
                    moreOptions.color = customApp.thresholdLtTextColor;
                    moreOptions.rainbow = false; // disable rainbow
                }
                if (customApp.thresholdLtBackgroundColor) {
                    moreOptions.background = customApp.thresholdLtBackgroundColor;

                    if (customApp.useBackgroundEffect) {
                        delete moreOptions.effect;
                    }
                }
            } else if (customApp.thresholdGtActive && val > customApp.thresholdGtValue) {
                this.log.debug(`[createAppRequestObj] GT > custom app "${customApp.name}" has a value (${val}) greater than ${customApp.thresholdGtValue} - overriding values`);

                if (customApp.thresholdGtIcon) {
                    moreOptions.icon = customApp.thresholdGtIcon;
                }
                if (customApp.thresholdGtTextColor) {
                    moreOptions.color = customApp.thresholdGtTextColor;
                    moreOptions.rainbow = false; // disable rainbow
                }
                if (customApp.thresholdGtBackgroundColor) {
                    moreOptions.background = customApp.thresholdGtBackgroundColor;

                    if (customApp.useBackgroundEffect) {
                        delete moreOptions.effect;
                    }
                }
            }
        }

        return {
            text,
            textCase: 2, // show as sent
            pos: customApp.position,
            ...moreOptions,
        };
    }

    private async initHistoryApps(): Promise<void> {
        if (this.apiConnected && this.config.historyApps.length > 0) {
            const validSourceInstances: Array<string> = [];

            // Check for valid history instances (once)
            for (const historyApp of this.config.historyApps) {
                if (historyApp.sourceInstance && !validSourceInstances.includes(historyApp.sourceInstance)) {
                    const sourceInstanceObj = await this.getForeignObjectAsync(`system.adapter.${historyApp.sourceInstance}`);

                    if (sourceInstanceObj && sourceInstanceObj.common?.getHistory) {
                        const sourceInstanceAliveState = await this.getForeignStateAsync(`system.adapter.${historyApp.sourceInstance}.alive`);

                        if (sourceInstanceAliveState && sourceInstanceAliveState.val) {
                            this.log.debug(`[initHistoryApps] Found valid source instance for history data: ${historyApp.sourceInstance}`);

                            validSourceInstances.push(historyApp.sourceInstance);
                        } else {
                            this.log.warn(`[initHistoryApps] Unable to get history data of "${historyApp.sourceInstance}": instance not running (stopped)`);
                        }
                    } else {
                        this.log.warn(`[initHistoryApps] Unable to get history data of "${historyApp.sourceInstance}": no valid source for getHistory()`);
                    }
                }
            }

            for (const historyApp of this.config.historyApps) {
                if (historyApp.name) {
                    if (historyApp.objId && historyApp.sourceInstance) {
                        this.log.debug(`[initHistoryApps] getting history data for app "${historyApp.name}" of "${historyApp.objId}" from ${historyApp.sourceInstance}`);

                        try {
                            const appVisibleState = await this.getStateAsync(`apps.${historyApp.name}.visible`);
                            const appVisible = appVisibleState ? appVisibleState.val : true;

                            // Ack if changed while instance was stopped
                            if (appVisibleState && !appVisibleState?.ack) {
                                await this.setStateAsync(`apps.${historyApp.name}.visible`, { val: appVisible, ack: true, c: 'initHistoryApps' });
                            }

                            if (!appVisible) {
                                this.log.debug(`[initHistoryApps] Going to remove history app "${historyApp.name}" (was hidden by state: apps.${historyApp.name}.visible)`);

                                await this.removeApp(historyApp.name).catch((error) => {
                                    this.log.warn(`Unable to remove history app "${historyApp.name}" (hidden by state): ${error}`);
                                });
                            } else if (validSourceInstances.includes(historyApp.sourceInstance)) {
                                const sourceObj = await this.getForeignObjectAsync(historyApp.objId);

                                if (sourceObj && Object.prototype.hasOwnProperty.call(sourceObj?.common?.custom ?? {}, historyApp.sourceInstance)) {
                                    const itemCount = historyApp.icon ? 11 : 16; // Can display 11 values with icon or 16 values without icon

                                    const historyData = await this.sendToAsync(historyApp.sourceInstance, 'getHistory', {
                                        id: historyApp.objId,
                                        options: {
                                            start: 1,
                                            end: Date.now(),
                                            aggregate: 'none',
                                            limit: itemCount,
                                            returnNewestEntries: true,
                                            ignoreNull: 0,
                                            removeBorderValues: true,
                                            ack: true,
                                        },
                                    });
                                    const lineData = (historyData as any)?.result
                                        .filter((state: ioBroker.State) => typeof state.val === 'number' && state.ack)
                                        .map((state: ioBroker.State) => Math.round(state.val as number))
                                        .slice(itemCount * -1);

                                    this.log.debug(
                                        `[initHistoryApps] History data for app "${historyApp.name}" of "${historyApp.objId}: ${JSON.stringify(historyData)} - filtered: ${JSON.stringify(lineData)}`,
                                    );

                                    if (lineData.length > 0) {
                                        const moreOptions: Awtrix.App = {};

                                        // Duration
                                        if (historyApp.duration > 0) {
                                            moreOptions.duration = historyApp.duration;
                                        }

                                        // Repeat
                                        if (historyApp.repeat > 0) {
                                            moreOptions.repeat = historyApp.repeat;
                                        }

                                        await this.buildAppRequestAsync(historyApp.name, {
                                            color: historyApp.lineColor || '#FF0000',
                                            background: historyApp.backgroundColor || '#000000',
                                            line: lineData,
                                            autoscale: true,
                                            icon: historyApp.icon,
                                            lifetime: this.config.historyAppsRefreshInterval + 60, // Remove app if there is no update in configured interval (+ buffer)
                                            pos: historyApp.position,
                                            ...moreOptions,
                                        }).catch((error) => {
                                            this.log.warn(`(custom?name=${historyApp.name}) Unable to create history app "${historyApp.name}": ${error}`);
                                        });
                                    } else {
                                        this.log.debug(`[initHistoryApps] Going to remove history app "${historyApp.name}" (no history data)`);

                                        await this.removeApp(historyApp.name).catch((error) => {
                                            this.log.warn(`Unable to remove history app "${historyApp.name}" (no history data): ${error}`);
                                        });
                                    }
                                } else {
                                    this.log.info(`[initHistoryApps] Unable to get history data for app "${historyApp.name}" of "${historyApp.objId}": logging is not configured for this object`);
                                }
                            } else {
                                this.log.info(`[initHistoryApps] Unable to get history data for app "${historyApp.name}" of "${historyApp.objId}": source invalid or unavailable`);
                            }
                        } catch (error) {
                            this.log.error(`[initHistoryApps] Unable to get history data for app "${historyApp.name}" of "${historyApp.objId}": ${error}`);
                        }
                    }
                } else {
                    this.log.warn(`[initHistoryApps] Found history app without name (skipped) - please check instance configuartion`);
                }
            }
        }

        if (this.config.historyApps.length > 0) {
            this.log.debug(`re-creating history apps timeout (${this.config.historyAppsRefreshInterval ?? 300} seconds)`);
            this.refreshHistoryAppsTimeout =
                this.refreshHistoryAppsTimeout ||
                this.setTimeout(
                    () => {
                        this.refreshHistoryAppsTimeout = null;
                        this.initHistoryApps();
                    },
                    this.config.historyAppsRefreshInterval * 1000 || 300 * 1000,
                );
        }
    }

    private async initExpertApps(): Promise<void> {}

    private async createAppObjects(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            if (this.apiConnected) {
                this.buildRequestAsync('apps', 'GET')
                    .then(async (response) => {
                        if (response.status === 200) {
                            const content = response.data as Array<{ name: string; }>;

                            const appPath = 'apps';
                            const customApps = this.config.customApps.map((a) => a.name);
                            const historyApps = this.config.historyApps.map((a) => a.name);
                            const expertApps = this.config.expertApps.map((a) => a.name);
                            const existingApps = content.map((a) => a.name);
                            const allApps = [...NATIVE_APPS, ...customApps, ...historyApps, ...expertApps];

                            this.log.debug(`[createAppObjects] existing apps on awtrix light: ${JSON.stringify(existingApps)}`);

                            const appsAll = [];
                            const appsKeep = [];

                            // Collect all existing apps from objects
                            const existingChannels = await this.getChannelsOfAsync(appPath);
                            if (existingChannels) {
                                for (const existingChannel of existingChannels) {
                                    const id = this.removeNamespace(existingChannel._id);

                                    // Check if the state is a direct child (e.g. apps.temp)
                                    if (id.split('.').length === 2) {
                                        appsAll.push(id);
                                    }
                                }
                            }

                            // Create new app structure for all native apps and apps of instance configuration
                            for (const name of allApps) {
                                appsKeep.push(`${appPath}.${name}`);
                                this.log.debug(`[createAppObjects] found (keep): ${appPath}.${name}`);

                                const isCustomApp = customApps.includes(name);
                                const isHistoryApp = historyApps.includes(name);
                                const isExpertApp = expertApps.includes(name);

                                await this.extendObjectAsync(`${appPath}.${name}`, {
                                    type: 'channel',
                                    common: {
                                        name: `App`,
                                        desc: `${name}${isCustomApp ? ' (custom app)' : ''}${isHistoryApp ? ' (history app)' : ''}${isExpertApp ? ' (expert app)' : ''}`,
                                    },
                                    native: {
                                        isNativeApp: NATIVE_APPS.includes(name),
                                        isCustomApp,
                                        isHistoryApp,
                                        isExpertApp,
                                    },
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
                                            //uk: 'Активувати',
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

                                // "Own" apps can be hidden via state
                                if (isCustomApp || isHistoryApp || isExpertApp) {
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
                                                //uk: 'Вибрані',
                                                'zh-cn': '不可抗辩',
                                            },
                                            type: 'boolean',
                                            role: 'switch.enable',
                                            read: true,
                                            write: true,
                                            def: true,
                                        },
                                        native: {
                                            name,
                                        },
                                    });

                                    if (isExpertApp) {
                                        await this.setObjectNotExistsAsync(`${appPath}.${name}.text`, {
                                            type: 'state',
                                            common: {
                                                name: {
                                                    en: 'Text',
                                                    de: 'Text',
                                                    ru: 'Текст',
                                                    pt: 'Texto',
                                                    nl: 'Text',
                                                    fr: 'Texte',
                                                    it: 'Testo',
                                                    es: 'Texto',
                                                    pl: 'Tekst',
                                                    //uk: 'Головна',
                                                    'zh-cn': '案文',
                                                },
                                                type: 'string',
                                                role: 'text',
                                                read: true,
                                                write: true,
                                            },
                                            native: {
                                                name,
                                            },
                                        });
                                    }
                                }
                            }

                            // Delete non existent apps
                            for (const app of appsAll) {
                                if (!appsKeep.includes(app)) {
                                    await this.delObjectAsync(app, { recursive: true });
                                    this.log.debug(`[createAppObjects] deleted: ${app}`);
                                }
                            }

                            if (this.config.autoDeleteForeignApps) {
                                // Delete unknown apps on awtrix light
                                for (const name of existingApps.filter((a) => !allApps.includes(a))) {
                                    this.log.info(`[createAppObjects] Deleting unknown app on awtrix light with name "${name}"`);

                                    try {
                                        await this.removeApp(name).catch((error) => {
                                            this.log.warn(`Unable to remove unknown app "${name}": ${error}`);
                                        });
                                    } catch (error) {
                                        this.log.error(`[createAppObjects] Unable to delete unknown app ${name}: ${error}`);
                                    }
                                }
                            }

                            resolve(appsKeep.length);
                        } else {
                            this.log.warn(`[createAppObjects] received status code: ${response.status}`);

                            reject(`received status code: ${response.status}`);
                        }
                    })
                    .catch((error) => {
                        this.log.debug(`[createAppObjects] received error: ${JSON.stringify(error)}`);

                        reject(error);
                    });
            }
        });
    }

    private async updateIndicatorByStates(index: number): Promise<AxiosResponse> {
        this.log.debug(`Updating indicator with index ${index}`);

        const indicatorStates = await this.getStatesAsync(`indicator.${index}.*`);
        const indicatorValues: { [key: string]: ioBroker.StateValue } = Object.entries(indicatorStates).reduce(
            (acc, [objId, state]) => ({
                ...acc,
                [this.removeNamespace(objId)]: state.val,
            }),
            {},
        );

        const postObj: Awtrix.Indicator = {
            color: indicatorValues[`indicator.${index}.color`] as string,
        };

        if (postObj.color !== '0') {
            const blink = indicatorValues[`indicator.${index}.blink`] as number;
            if (blink > 0) {
                postObj.blink = blink;
            }
        }

        return this.buildRequestAsync(`indicator${index}`, 'POST', indicatorValues[`indicator.${index}.active`] ? postObj : undefined);
    }

    private async updateMoodlightByStates(): Promise<AxiosResponse> {
        this.log.debug(`Updating moodlight`);

        const moodlightStates = await this.getStatesAsync('display.moodlight.*');
        const moodlightValues: { [key: string]: ioBroker.StateValue } = Object.entries(moodlightStates).reduce(
            (acc, [objId, state]) => ({
                ...acc,
                [this.removeNamespace(objId)]: state.val,
            }),
            {},
        );

        const postObj: Awtrix.Moodlight = {
            brightness: moodlightValues['display.moodlight.brightness'] as number,
            color: String(moodlightValues['display.moodlight.color']).toUpperCase(),
        };

        return this.buildRequestAsync('moodlight', 'POST', moodlightValues['display.moodlight.active'] ? postObj : undefined);
    }

    private async buildAppRequestAsync(name: string, data?: Awtrix.App): Promise<AxiosResponse> {
        return this.buildRequestAsync(`custom?name=${name}`, 'POST', data);
    }

    private async buildRequestAsync(service: string, method?: string, data?: object): Promise<AxiosResponse> {
        return new Promise<AxiosResponse>((resolve, reject) => {
            const url = `/api/${service}`;
            const timeout = this.config.httpTimeout * 1000 || 3000;

            if (this.config.awtrixIp) {
                if (data) {
                    this.log.debug(`sending "${method}" request to "${url}" with data: ${JSON.stringify(data)}`);
                } else {
                    this.log.debug(`sending "${method}" request to "${url}" without data`);
                }

                axios({
                    method,
                    data,
                    baseURL: `http://${this.config.awtrixIp}:80`,
                    url,
                    timeout,
                    auth: {
                        username: this.config.userName,
                        password: this.config.userPassword,
                    },
                    validateStatus: (status) => {
                        return [200, 201].indexOf(status) > -1;
                    },
                    responseType: 'json',
                })
                    .then((response) => {
                        this.log.debug(`received ${response.status} response from "${url}" with content: ${JSON.stringify(response.data)}`);

                        // no error - clear up reminder
                        this.lastErrorCode = -1;

                        resolve(response);
                    })
                    .catch((error) => {
                        if (error.response) {
                            // The request was made and the server responded with a status code

                            if (error.response.status === 401) {
                                this.log.warn('Unable to perform request. Looks like the device is protected with username / password. Check instance configuration!');
                            } else {
                                this.log.warn(`received ${error.response.status} response from ${url} with content: ${JSON.stringify(error.response.data)}`);
                            }
                        } else if (error.request) {
                            // The request was made but no response was received
                            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                            // http.ClientRequest in node.js

                            // avoid spamming of the same error when stuck in a reconnection loop
                            if (error.code === this.lastErrorCode) {
                                this.log.debug(error.message);
                            } else {
                                this.log.info(`error ${error.code} from ${url}: ${error.message}`);
                                this.lastErrorCode = error.code;
                            }
                        } else {
                            // Something happened in setting up the request that triggered an Error
                            this.log.error(error.message);
                        }

                        reject(error);
                    });
            } else {
                reject('Device IP is not configured');
            }
        });
    }

    private removeNamespace(id: string): string {
        const re = new RegExp(this.namespace + '*\\.', 'g');
        return id.replace(re, '');
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.config.removeAppsOnStop) {
                const customApps = this.config.customApps.map((a) => a.name);
                const historyApps = this.config.historyApps.map((a) => a.name);

                // Delete unknown apps on awtrix light
                for (const name of [...customApps, ...historyApps]) {
                    this.log.info(`[onUnload] Deleting app on awtrix light with name "${name}"`);

                    try {
                        await this.removeApp(name).catch((error) => {
                            this.log.warn(`Unable to remove unknown app "${name}": ${error}`);
                        });
                    } catch (error) {
                        this.log.error(`[onUnload] Unable to delete app ${name}: ${error}`);
                    }
                }
            }

            await this.setApiConnected(false);

            if (this.refreshStateTimeout) {
                this.log.debug('clearing refresh state timeout');
                this.clearTimeout(this.refreshStateTimeout);
            }

            if (this.refreshHistoryAppsTimeout) {
                this.log.debug('clearing history apps timeout');
                this.clearTimeout(this.refreshHistoryAppsTimeout);
            }

            if (this.downloadScreenContentInterval) {
                this.clearInterval(this.downloadScreenContentInterval);
                this.downloadScreenContentInterval = null;
            }

            callback();
        } catch (e) {
            callback();
        }
    }

    private isNewerVersion(oldVer: string, newVer: string): boolean {
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
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new AwtrixLight(options);
} else {
    // otherwise start the instance directly
    (() => new AwtrixLight())();
}
