// Private implementation.
(function() {

// Increments for every Downloader created.
let gDownloaderCounter = 0;


class Downloader {
  constructor() {
    this.errors = [];
    this.id = ++gDownloaderCounter;

    this.scriptDownload = null;
    this.iconDownload = null;
    this.requireDownloads = {};
    this.resourceDownloads = {};

    this.completion = new Promise((resolve, reject) => {
      this._completionResolve = resolve;
      this._completionReject = reject;
    });
    this.scriptDetails = new Promise((resolve, reject) => {
      this._scriptDetailsResolve = resolve;
      this._scriptDetailsReject = reject;
    });

    this._knownIconUrl = null;
    this._knownIconBlob = null;
    this._knownRequires = {};
    this._knownResources = {};

    this._progressListeners = [];

    this._scriptContent = null;
    this._scriptDetailsResolved = false;
    this._scriptUrl = null;
  }

  get progress() {
    let p = this.scriptDownload.progress +
        (this.iconDownload ? this.iconDownload.progress : 0)
        + Object.values(this.requireDownloads)
            .map(d => d.progress).reduce((a, b) => a + b, 0)
        + Object.values(this.resourceDownloads)
            .map(d => d.progress).reduce((a, b) => a + b, 0);
    let t = 1 + (this.iconDownload ? 1 : 0)
        + Object.keys(this.requireDownloads).length
        + Object.keys(this.resourceDownloads).length;
    return p / t;
  }

  setKnownIcon(url, blob) {
    this._knownIconUrl = url;
    this._knownIconBlob = blob;
  }
  setKnownRequires(requires) { this._knownRequires = requires; }
  setKnownResources(resources) { this._knownResources = resources; }

  setScriptUrl(val) { this._scriptUrl = val; return this; }
  setScriptContent(val) { this._scriptContent = val; return this; }

  addProgressListener(cb) {
    this._progressListeners.push(cb);
  }

  // TODO: Rename this to "results"?
  async details() {
    let details = {
      'content': await this.scriptDownload.result,
      'icon': this.iconDownload && await this.iconDownload.result,
      'requires': {},
      'resources': {},
    };

    // Synchronous loops so `await` blocks our async. return.
    // TODO: Is this necessary?
    for (let [u, d] of Object.entries(this.requireDownloads)) {
      details.requires[u] = await d.result;
    }

    for (let [n, d] of Object.entries(this.resourceDownloads)) {
      details.resources[n] = {
        'name': n,
        'mimetype': d.mimeType,
        'blob': await d.result,
      };
    }

    return details;
  }

  async install() {
    return new Promise(async (resolve, reject) => {
      let scriptDetails = await this.scriptDetails;
      let downloaderDetails = await this.details();
      chrome.runtime.sendMessage({
        'name': 'UserScriptInstall',
        'userScript': scriptDetails,
        'downloader': downloaderDetails,
      }, (uuid) => {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          resolve(uuid);
        }
      });
    });
  }

  async start() {
    if (this._scriptContent != null) {
      this.scriptDownload = new ImmediateDownload(this._scriptContent);
      let scriptDetails = parseUserScript(this._scriptContent, this._scriptUrl);
      if (scriptDetails) {
        this._scriptDetailsResolve(scriptDetails);
      }
      this._scriptDetailsResolved = true;
    } else {
      this.scriptDownload = new Download(
          this._onProgress.bind(this), this._scriptUrl);
    }

    let scriptDetails = await this.scriptDetails;

    if (scriptDetails.iconUrl) {
      if (this._knownIconUrl == scriptDetails.iconUrl) {
        this.iconDownload = new ImmediateDownload(this._knownIconBlob);
      } else {
        this.iconDownload = new Download(
            this._onProgress.bind(this), scriptDetails.iconUrl,
            /*binary=*/true);
      }
    }

    scriptDetails.requireUrls.forEach(u => {
      if (this._knownRequires[u]) {
        this.requireDownloads[u]
            = new ImmediateDownload(this._knownRequires[u]);
      } else {
        this.requireDownloads[u]
            = new Download(this._onProgress.bind(this), u);
      }
    });

    Object.keys(scriptDetails.resourceUrls).forEach(n => {
      let u = scriptDetails.resourceUrls[n];
      if (this._knownResources[u]) {
        this.resourceDownloads[n]
            = new ImmediateDownload(this._knownResources[u]);
      } else {
        this.resourceDownloads[n]
            = new Download(this._onProgress.bind(this), u, /*binary=*/true);
      }
    });

    await this.scriptDownload.result;
    if (this.iconDownload) await this.iconDownload.result;
    await Promise.all(Object.values(this.requireDownloads).map(d => d.result));
    await Promise.all(Object.values(this.resourceDownloads).map(d => d.result));

    this._completionResolve();
  }

  _onProgress(download, event) {
    if (!this._scriptDetailsResolved
        && download == this.scriptDownload
    ) {
      let responseSoFar = event.target.response;
      try {
        let scriptDetail = parseUserScript(responseSoFar, this._scriptUrl);
        if (scriptDetail) {
          this._scriptDetailsResolve(scriptDetail);
          this._scriptDetailsResolved = true;
        }
      } catch (e) {
        // If the download is still pending, errors might be resolved as we
        // finish.  If not, errors are fatal.
        if (!download.pending) {
          this._scriptDetailsReject(e);
          this._completionReject(e);
          return;
        }
      }
    }

    this._progressListeners.forEach(
        listener => listener.call([this]));
  }
}
window.UserScriptDownloader = Downloader;


class Download {
  constructor(progressCb, url, binary=false) {
    this.mimeType = null;
    this.progress = 0;
    this.status = null;
    this.statusText = null;

    this._progressCb = progressCb;
    this._url = url;

    this.result = new Promise((resolve, reject) => {
      let xhr = new XMLHttpRequest();

      xhr.addEventListener('abort', this._onError.bind(this, reject));
      xhr.addEventListener('error', this._onError.bind(this, reject));
      xhr.addEventListener('load', this._onLoad.bind(this, xhr, resolve));
      xhr.addEventListener('progress', this._onProgress.bind(this));

      xhr.open('GET', url);
      if (binary) xhr.responseType = 'blob';

      xhr.send();
    });
  }

  _onError(reject, event) {
    this.progress = 1;
    reject();
  }

  _onLoad(xhr, resolve, event) {
    this.mimeType = xhr.getResponseHeader('Content-Type');
    this.progress = 1;
    this.status = xhr.status;
    this.statusText = xhr.statusText;
    resolve(xhr.response);
  }

  _onProgress(event) {
    this.progress = event.lengthComputable
        ? event.loaded / event.total
        : 0;
    this._progressCb(this, event);
  }
}


class ImmediateDownload {
  constructor(source) {
    this.progress = 1;
    this.result = Promise.resolve(source);
    this.status = 200;
    this.statusText = 'OK';
  }
}

})();
