/**
 * Copyright (C) 2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
import {getHash, filterAsync} from '../lib/util';
import {MAIN_KEYRING_ID} from '../lib/constants';
import * as sub from './sub.controller';
import {key as openpgpKey} from 'openpgp';
import {mapKeys, parseUserId, getLastModifiedDate, sanitizeKey} from '../modules/key';
import * as keyRegistry from '../modules/keyRegistry';
import * as gmail from '../modules/gmail';
import {initOpenPGP, decryptFile, encryptMessage, decryptMessage, encryptFile} from '../modules/pgpModel';
import {getById as keyringById, getAllKeyringAttr, getAllKeyringIds, setKeyringAttr, deleteKeyring, getKeyData, getDefaultKeyFpr} from '../modules/keyring';
import {delete as deletePwdCache, get as getKeyPwdFromCache, unlock as unlockKey} from '../modules/pwdCache';
import {initScriptInjection} from '../lib/inject';
import * as prefs from '../modules/prefs';
import * as uiLog from '../modules/uiLog';
import {getVersion} from '../modules/defaults';
import {gpgme} from '../lib/browser.runtime';
import * as mveloKeyServer from '../modules/mveloKeyServer';
import * as autocrypt from '../modules/autocryptWrapper';
import {ci} from '../lib/analytics';

export default class AppController extends sub.SubController {
  constructor(port) {
    super(port);
    if (!port) {
      this.mainType = 'app';
      this.id = getHash();
    }
    // register event handlers
    this.on('get-prefs', () => prefs.prefs);
    this.on('set-prefs', this.updatePreferences);
    this.on('decrypt-file', this.decryptFile);
    this.on('decrypt-message', this.decryptMessage);
    this.on('decrypt-message-init', this.initDecryptMessage);
    this.on('decrypt-message-popup', this.openPopupDecryptMessage);
    this.on('encrypt-message', this.encryptMessage);
    this.on('encrypt-file', this.encryptFile);
    this.on('getWatchList', prefs.getWatchList);
    this.on('getKeys', ({keyringId}) => keyringById(keyringId).getKeys());
    this.on('removeKey', this.removeKey);
    this.on('revokeKey', this.revokeKey);
    this.on('get-keyserver-sync', this.getKeyServerSync);
    this.on('sync-keyserver', this.syncKeyServer);
    this.on('remove-user', this.removeUser);
    this.on('revoke-user', this.revokeUser);
    this.on('add-user', this.addUser);
    this.on('set-key-expiry-date', this.setKeyExDate);
    this.on('set-key-password', this.setKeyPwd);
    this.on('validate-key-password', this.validateKeyPassword);
    this.on('getArmoredKeys', this.getArmoredKeys);
    this.on('getKeyDetails', this.getKeyDetails);
    this.on('generateKey', this.generateKey);
    this.on('importKeys', this.importKeys);
    this.on('set-watch-list', this.setWatchList);
    this.on('init-script-injection', initScriptInjection);
    this.on('get-all-keyring-attr', getAllKeyringAttr);
    this.on('set-keyring-attr', ({keyringId, keyringAttr}) => setKeyringAttr(keyringId, keyringAttr));
    this.on('get-active-keyring', sub.getActiveKeyringId);
    this.on('set-active-keyring', ({keyringId}) => sub.setActiveKeyringId(keyringId));
    this.on('delete-keyring', this.deleteKeyring);
    this.on('get-ui-log', ({securityLogLength}) => uiLog.getLatest(securityLogLength));
    this.on('get-version', getVersion);
    this.on('get-all-key-data', () => getKeyData({allUsers: false}));
    this.on('open-tab', ({url}) => mvelo.tabs.create(url));
    this.on('get-app-data-slot', ({slotId}) => sub.getAppDataSlot(slotId));
    this.on('get-gnupg-status', () => Boolean(gpgme));
    this.on('reload-keystore', ({keyringId}) => keyringById(keyringId).keystore.load());
    this.on('read-amored-keys', this.readArmoredKeys);
    this.on('auto-locate', this.autoLocate);
    this.on('get-default-key-fpr', ({keyringId}) => getDefaultKeyFpr(keyringId));
    this.on('get-signing-keys', ({keyringId}) => keyringById(keyringId).getValidSigningKeys());
    this.on('get-oauth-tokens', this.getOAuthTokens);
    this.on('remove-oauth-token', this.removeOAuthToken);
    this.on('authorize-gmail', this.authorizeGmail);
    this.on('check-license', this.checkLicense);
    this.on('grant-consent', this.grantConsent);
    this.on('deny-consent', this.denyConsent);
    this.on('get-consent', this.getConsent);
  }

  // TODO: is there a way to put these right in settings/Analytics.js or must they be here to use the
  // background storage?  Putting them there resulted in storage wiping itself out.
  async getConsent({campaignId}) {
    return ci.isCampaignCurrentlyGranted(campaignId);
  }

  async grantConsent({campaignId}) {
    ci.grantCampaign(campaignId);
  }

  async denyConsent({campaignId}) {
    ci.denyCampaign(campaignId);
  }

  async updatePreferences(options) {
    const updateOpenPGPFlag = options.prefs.security && options.prefs.security.hide_armored_header !== prefs.prefs.security.hide_armored_header;
    const disabledAutocryptFlag = options.prefs.keyserver && options.prefs.keyserver.autocrypt_lookup === false  && prefs.prefs.keyserver.autocrypt_lookup;
    const reloadExtensionFlag = options.prefs.provider && options.prefs.provider.gmail_integration !== prefs.prefs.provider.gmail_integration;
    await prefs.update(options.prefs);
    // update content scripts
    sub.getByMainType('mainCS').forEach(mainCScontrl => mainCScontrl.updatePrefs());
    if (updateOpenPGPFlag) {
      initOpenPGP();
    }
    if (disabledAutocryptFlag) {
      await autocrypt.deleteIdentities(getAllKeyringIds());
    }
    if (reloadExtensionFlag) {
      sub.reloadFrames();
    }
  }

  async removeKey({fingerprint, type, keyringId}) {
    const result = await keyringById(keyringId).removeKey(fingerprint, type);
    this.sendKeyUpdate();
    return result;
  }

  async removeUser({fingerprint, userId, keyringId}) {
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    const result = await keyringById(keyringId).removeUser(privateKey, userId);
    this.sendKeyUpdate();
    return result;
  }

  async addUser({fingerprint, user, keyringId}) {
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    const unlockedKey = await this.unlockKey({key: privateKey, reason: 'PWD_DIALOG_REASON_ADD_USER'});
    const result = await keyringById(keyringId).addUser(unlockedKey, user);
    this.sendKeyUpdate();
    deletePwdCache(fingerprint);
    return result;
  }

  async revokeUser({fingerprint, userId, keyringId}) {
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    const unlockedKey = await this.unlockKey({key: privateKey, reason: 'PWD_DIALOG_REASON_REVOKE_USER'});
    const result = await keyringById(keyringId).revokeUser(unlockedKey, userId);
    this.sendKeyUpdate();
    return result;
  }

  async revokeKey({fingerprint, keyringId}) {
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    const unlockedKey = await this.unlockKey({key: privateKey, reason: 'PWD_DIALOG_REASON_REVOKE'});
    const result = await keyringById(keyringId).revokeKey(unlockedKey);
    this.sendKeyUpdate();
    return result;
  }

  async getKeyServerSync({fingerprint, keyringId}) {
    const result = {
      status: false,
      userIds: {}
    };
    try {
      const localKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint).toPublic();
      const remote = await mveloKeyServer.fetch({fingerprint});
      if (!remote) {
        return result;
      }
      // found key on server
      for (const userId of remote.userIds) {
        // get remote user IDs
        result.userIds[userId.email] = userId.verified;
      }
      // filter local user IDs to match remote userIDs
      localKey.users = localKey.users.filter(({userId: {email}}) => Object.keys(result.userIds).includes(email) && result.userIds[email]);
      const {keys: [remoteKey]} = await openpgpKey.readArmored(remote.publicKeyArmored);
      const remoteKeyModTime = new Date(getLastModifiedDate(remoteKey)).getTime();
      const localKeyModTime = new Date(getLastModifiedDate(localKey)).getTime();
      if (remoteKeyModTime !== localKeyModTime) {
        result.status = 'mod';
      } else {
        result.status = 'sync';
      }
    } catch (e) {}
    return result;
  }

  async syncKeyServer({emails, fingerprint, keyringId, sync}) {
    let result;
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    if (sync) {
      result = await mveloKeyServer.upload({emails, publicKeyArmored: privateKey.toPublic().armor()});
    } else {
      let options;
      if (emails.length) {
        options = {email: emails[0]};
      } else {
        const keyId = privateKey.primaryKey.getKeyId().toHex();
        options = {keyId};
      }
      result = await mveloKeyServer.remove(options);
    }
    return result;
  }

  async setKeyExDate({fingerprint, keyringId, newExDateISOString}) {
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    const unlockedKey = await this.unlockKey({key: privateKey, reason: 'PWD_DIALOG_REASON_SET_EXDATE'});
    const newExDate = newExDateISOString !== false ? new Date(newExDateISOString) : false;
    const result = await keyringById(keyringId).setKeyExDate(unlockedKey, newExDate);
    this.sendKeyUpdate();
    deletePwdCache(fingerprint);
    return result;
  }

  async setKeyPwd({fingerprint, keyringId, currentPassword, password}) {
    const privateKey = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
    const unlockedKey = await unlockKey({key: privateKey, password: currentPassword});
    const result = await keyringById(keyringId).setKeyPwd(unlockedKey, password);
    this.sendKeyUpdate();
    deletePwdCache(fingerprint);
    return result;
  }

  async validateKeyPassword({fingerprint, keyringId, password}) {
    const cached = getKeyPwdFromCache(fingerprint);
    if (cached && cached.password) {
      return password === cached.password;
    } else {
      const key = keyringById(keyringId).getPrivateKeyByFpr(fingerprint);
      try {
        await unlockKey({key, password});
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  getArmoredKeys({keyFprs, options, keyringId}) {
    return keyringById(keyringId).getArmoredKeys(keyFprs, options);
  }

  getKeyDetails({fingerprint, keyringId}) {
    return keyringById(keyringId).getKeyDetails(fingerprint);
  }

  async generateKey({parameters, keyringId}) {
    const result = await keyringById(keyringId).generateKey(parameters);
    result.keyId = result.key.primaryKey.getKeyId().toHex().toUpperCase();
    this.sendKeyUpdate();
    return result;
  }

  async importKeys({keys, keyringId}) {
    const result = await keyringById(keyringId).importKeys(keys);
    this.sendKeyUpdate();
    return result;
  }

  sendKeyUpdate() {
    sub.getByMainType('editor').forEach(editorCntrl => editorCntrl.sendKeyUpdate());
  }

  async setWatchList({data}) {
    await prefs.setWatchList(data);
    initScriptInjection();
  }

  async deleteKeyring({keyringId}) {
    if (keyringId === MAIN_KEYRING_ID) {
      throw new Error('Cannot delete main keyring');
    }
    sub.setActiveKeyringId(MAIN_KEYRING_ID);
    await deleteKeyring(keyringId);
    await autocrypt.deleteIdentities([keyringId]);
  }

  async encryptMessage(options) {
    options.unlockKey = async options => {
      options.reason = 'PWD_DIALOG_REASON_SIGN';
      const result = await this.unlockKey(options);
      return result;
    };
    if (prefs.prefs.general.auto_add_primary) {
      // get the sender key fingerprint
      const defaultKeyFpr = await getDefaultKeyFpr(MAIN_KEYRING_ID);
      if (defaultKeyFpr && !options.encryptionKeyFprs.includes(defaultKeyFpr)) {
        options.encryptionKeyFprs.push(defaultKeyFpr);
      }
    }
    return encryptMessage(options);
  }

  async encryptFile(options) {
    options.unlockKey = async options => {
      options.reason = 'PWD_DIALOG_REASON_SIGN';
      const result = await this.unlockKey(options);
      return result;
    };
    if (prefs.prefs.general.auto_add_primary) {
      // get the sender key fingerprint
      const defaultKeyFpr = await getDefaultKeyFpr(MAIN_KEYRING_ID);
      if (defaultKeyFpr && !options.encryptionKeyFprs.includes(defaultKeyFpr)) {
        options.encryptionKeyFprs.push(defaultKeyFpr);
      }
    }
    return encryptFile(options);
  }

  decryptFile(options) {
    options.unlockKey = async options => {
      options.reason = 'PWD_DIALOG_REASON_DECRYPT';
      const result = await this.unlockKey(options);
      return result;
    };
    return decryptFile(options);
  }

  decryptMessage(options) {
    options.unlockKey = async options => {
      options.reason = 'PWD_DIALOG_REASON_DECRYPT';
      const result = await this.unlockKey(options);
      return result;
    };
    return decryptMessage(options);
  }

  initDecryptMessage() {
    this.decryptMessageCtrl = sub.factory.get('decryptCont');
    return this.decryptMessageCtrl.id;
  }

  async openPopupDecryptMessage({armored, keyringId}) {
    await this.decryptMessageCtrl.onDframeDisplayPopup();
    this.decryptMessageCtrl.on('decrypt-message-init', () => this.decryptMessageCtrl.onSetArmored({data: armored, keyringId, options: {}}));
  }

  async readArmoredKeys({armoredKeys}) {
    const errors = [];
    let publicKeys = [];
    const privateKeys = [];
    if (!armoredKeys.length) {
      return;
    }
    for (const armoredKey of armoredKeys) {
      const pgpKey = await openpgpKey.readArmored(armoredKey.armored);
      if (pgpKey.err) {
        for (const error of pgpKey.err) {
          console.log('Error on openpgp.key.readArmored', error);
          errors.push({msg: error.message, code: 'KEY_IMPORT_ERROR_PARSE'});
        }
      }
      if (armoredKey.type === 'public') {
        publicKeys.push(...pgpKey.keys);
      } else {
        privateKeys.push(...pgpKey.keys);
      }
    }
    // merge public into private
    publicKeys = await filterAsync(publicKeys, async pubKey => {
      const pubFpr = pubKey.primaryKey.getFingerprint();
      const privKey = privateKeys.find(priv => priv.primaryKey.getFingerprint() === pubFpr);
      if (!privKey) {
        return true;
      }
      await privKey.update(pubKey);
    });
    const keys = [...publicKeys, ...privateKeys];
    // sanitize keys
    const sanitizedKeys = [];
    for (const key of keys) {
      const saniKey = await sanitizeKey(key);
      if (!saniKey) {
        errors.push({msg: key.primaryKey.getFingerprint().toUpperCase(), code: 'KEY_IMPORT_ERROR_NO_UID'});
      } else {
        sanitizedKeys.push(key);
      }
    }
    const mappedKeys = await mapKeys(sanitizedKeys);
    for (const [keyIndex, mappedKey] of mappedKeys.entries()) {
      mappedKey.users = [];
      for (const [index, user] of keys[keyIndex].users.entries()) {
        if (!user.userId) {
          // filter out user attribute packages
          continue;
        }
        const userStatus = await user.verify(keys[keyIndex].primaryKey);
        const uiUser = {id: index, userId: user.userId.userid, name: user.userId.name, email: user.userId.email, status: userStatus};
        parseUserId(uiUser);
        mappedKey.users.push(uiUser);
      }
    }
    const validArmoreds = sanitizedKeys.map(key => ({
      type: key.isPublic() ? 'public' : 'private',
      armored: key.armor()
    }));
    return {keys: mappedKeys, errors, armoreds: validArmoreds};
  }

  async autoLocate({email, keyringId}) {
    const result = await keyRegistry.lookup(email, keyringId);
    if (result) {
      await keyringById(keyringId).importKeys([{type: 'public', armored: result.armored}]);
    }
  }

  async unlockKey(options) {
    const pwdControl = sub.factory.get('pwdDialog');
    const {key} = await pwdControl.unlockKey(options);
    return key;
  }

  async getOAuthTokens({provider}) {
    return mvelo.storage.get(`mvelo.oauth.${provider}`);
  }

  async removeOAuthToken({email}) {
    return gmail.unauthorize(email);
  }

  async authorizeGmail({email, legacyGsuite, scopes, gmailCtrlId}) {
    const gmailCtrl = sub.getById(gmailCtrlId);
    return gmailCtrl.onAuthorize({email, legacyGsuite, scopes});
  }

  async checkLicense({email}) {
    return gmail.checkLicense({email});
  }
}
