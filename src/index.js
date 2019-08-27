#!/usr/bin/env node
import http from 'q-io/http';
import fs from 'q-io/fs';
import keytar from 'keytar';
import { exec } from 'child_process';
import readline from 'readline';
import os from 'os';

const gitPath = Promise.resolve('git');
const home = process.platform === 'darwin' ? process.env.HOME : process.env.HOMEDRIVE + process.env.HOMEPATH;
const configFileName = '.clonejs';
const keytarService = 'clone-leeroy';
const keytarAccount = 'github-token';
let gitHubAccessToken = '';

console.log('clone-leeroy 0.11.1');

getGitHubAccessToken()
  .then(token => {
    if (!token) throw new Error('GitHub Personal Access Token was not specified.');
    gitHubAccessToken = token;
    return process.argv;
  })
  .then(([, , project, ...flags]) => {
    const parsedFlags = parseFlags(flags);
    if (!project) return readLeeroyConfig();
    else if (parsedFlags.save) return createLeeroyConfig(project);
    else return project;
  })
  .then(project => {
    if (!project) throw new Error('Usage: clone-leeroy [CONFIGNAME, file, url] [--save]');
    return fetchProjectConfiguration(project)
      .catch(() => { throw new Error(`Couldn't get Leeroy config file`); });
  })
  .then(data => {
    const config = JSON.parse(data);
    if (!config.submodules) throw new Error(`Leeroy config file is missing 'submodules' configuration.`);
    return config;
  })
  .then(config => {
    const createPromise = createSolutionInfos();
    return createPromise.then(() => {
      const promises = Object.keys(config.submodules).map(name => processSubmodule(name, config));
      return Promise.all(promises);
    });
  })
  .catch(error => {
    console.error('\x1b[31m' + (error.message || `Error: ${error}`) + '\x1b[0m');
    process.exitCode = 1;
  });

function getGitHubAccessToken() {
  const environmentToken = process.env.GITHUB_TOKEN;
  if (environmentToken) return Promise.resolve(environmentToken);
  return keytar.getPassword(keytarService, keytarAccount)
    .then(token =>
      {
        if (token) return token;
        return new Promise((resolve, reject) => {
          console.error(`A GitHub Personal Access Token is required. You can specify this with the
GITHUB_TOKEN environment variable, or enter one now (which will be saved
securely in your keychain).
To create a PAT, go to https://git.faithlife.dev/settings/tokens and create
one named 'clone-leeroy' with 'public_repo' permissions.`);

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          rl.question('Enter token or press Ctrl+C to use an environment variable: ', (enteredToken) => {
            rl.close();
            if (!enteredToken) {
              reject('GitHub Personal Access Token is required');
            } else {
              resolve(keytar.setPassword(keytarService, keytarAccount, enteredToken)
                .then(() => enteredToken));
            }
          });
        });
      });
}

function readLeeroyConfig() {
  return fs.read(configFileName)
    .then(content => {
      const settings = JSON.parse(content);
      return settings.leeroyConfig;
    })
    .catch(() => null);
}

function createLeeroyConfig(project) {
  const settings = { leeroyConfig: project };
  return fs.write(configFileName, JSON.stringify(settings))
    .then(() => project);
}

function createSolutionInfos() {
  const solutionInfos = [{
    name: 'SolutionInfo.cs',
    data: `using System.Reflection;

[assembly: AssemblyVersion("9.99.0.0")]
[assembly: AssemblyCompany("Faithlife")]
[assembly: AssemblyCopyright("Copyright 2015 Faithlife")]
[assembly: AssemblyDescription("Local Build")]
`
  },
  {
    name: 'SolutionInfo.h',
    data: `#pragma once

#define ASSEMBLY_VERSION_MAJOR 9
#define ASSEMBLY_VERSION_MINOR 99
#define ASSEMBLY_VERSION_BUILD 0
#define ASSEMBLY_VERSION_MAJOR_MINOR_BUILD 1337
#define ASSEMBLY_VERSION_REVISION 0
#define ASSEMBLY_VERSION_STRING "9.99.0.0"

#define ASSEMBLY_COMPANY "Faithlife"
#define ASSEMBLY_COPYRIGHT "Copyright 2015 Faithlife"
`
  }];

  return Promise.all(solutionInfos.map(info => fs.exists(info.name)
    .then(exists => exists || fs.write(info.name, info.data))
  ));
}

function processSubmodule(name, config) {
  const branch = config.submodules[name];

  const [owner, repo] = name.split('/');
  const submodule = {
    _logs: [],
    owner,
    repo,
    branch,
    remoteUrl: `git@git.faithlife.dev:${owner}/${repo}.git`,
    log(message, indent=0) { this._logs = this._logs.concat(message.split(/\r?\n/).map((line) => { return Array(indent + 1).join(' ') + line; })); },
    output() { return this._logs.join(os.EOL); }
  };
  submodule.log(`Processing ${name}`);

  return fs.exists(submodule.repo)
    .then(exists =>
      !exists ?
        clone(submodule) :
        checkRemote(submodule)
          .then(() => fetchOrigin(submodule))
          .then(() => checkBranch(submodule))
          .then(() => pull(submodule))
    )
    .then(() => {
      console.log(submodule.output());
    }).catch(error => {
        submodule.log(error.message || error, 2);
        return Promise.reject(submodule.output());
    });
}

function clone(submodule) {
  submodule.log(`Directory ${submodule.repo} does not exist; cloning it.`, 2);
  return exec_git(`clone --recursive --branch ${submodule.branch} ${submodule.remoteUrl}`, {});
}

function checkRemote(submodule) {
  return exec_git('config --get remote.origin.url', { cwd: submodule.repo })
    .then(currentRemoteUrl => {
      if (currentRemoteUrl !== submodule.remoteUrl) {
        submodule.log(`Changing origin URL from ${currentRemoteUrl} to ${submodule.remoteUrl}`, 2);
        return changeRemoteUrl(submodule);
      } else {
        return null;
    }
    });
}

function changeRemoteUrl(submodule) {
  return exec_git('remote rm origin', { cwd: submodule.repo })
    .then(() => exec_git(`remote add origin ${submodule.remoteUrl}`, { cwd: submodule.repo }));
}

function fetchOrigin(submodule) {
  submodule.log('Fetching commits from origin...', 2);
  return exec_git('fetch origin', { cwd: submodule.repo });
}

function checkBranch(submodule) {
  const gitOptions = { cwd: submodule.repo };
  return exec_git('symbolic-ref --short -q HEAD', gitOptions)
    .then(currentBranch => {
      if (currentBranch === submodule.branch) return null;
      submodule.log(`Switching branches from ${currentBranch} to ${submodule.branch}`, 2);
      return exec_git(`branch --list -q --no-color ${submodule.branch}`, gitOptions)
        .then(existingTargetBranch => checkoutBranch(submodule, existingTargetBranch === submodule.branch))
        .catch(err => fetchTags(submodule)
          .then(() => checkoutBranch(submodule))
          .catch(() => submodule.log(err)));
    });
}

function checkoutBranch(submodule, isNewBranch) {
  const command = isNewBranch
    ? `checkout -B ${submodule.branch} --track origin/${submodule.branch}`
    : `checkout ${submodule.branch}`;
  return exec_git(command, { cwd: submodule.repo });
}

function fetchTags(submodule) {
  return exec_git(`fetch --tags`, { cwd: submodule.repo });
}

function pull(submodule) {
  return exec_git(`pull --rebase origin ${submodule.branch}`, { cwd: submodule.repo })
    .then(pullOutput => Promise.all([pullOutput, exec_git('submodule update --init --recursive', { cwd: submodule.repo })]))
    .then(([pullOutput]) => {
        submodule.log(`${pullOutput}`, 2);
      });
}

function exec_git(args, options) {
  options.env = options.env || {};
  options.env.HOME = home;

  // Might be necessary on Mac OS X to set SSH_AUTH_SOCK if user
  // has configured SSH Agent Forwarding
  // See https://help.github.com/articles/using-ssh-agent-forwarding
  options.env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  return gitPath.then(path =>
    new Promise((resolve, reject) => {
      exec(`${path} ${args}`, options, (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout.toString().trim());
        }
      });
  }));
}

function parseFlags(flags) {
  // --save
  const parsedFlags = {};
  for (let flagIndex = 0; flagIndex < (flags || []).length; flagIndex++) {
    const flag = flags[flagIndex];
    const flagName = flag.startsWith('--') ? flag.substring(2) : null;
    if (flagName === 'save') {
      parsedFlags.save = true;
    }
    else {
      parsedFlags[flagName] = flags[++flagIndex];
    }
  }
  return parsedFlags;
}

function fetchProjectConfiguration(projectish) {
  return new Promise( (resolve, reject) => {
    fs.exists(projectish).then( fileExists => {
      if (fileExists)
      {
        fs.read(projectish).then( data => {
          console.log(`Read configuration from ${projectish}`);
          resolve(data);
        });
        return;
      }

      http
        .read(projectish)
        .then(data => {
          console.log(`Read configuration from ${projectish}`);
          resolve(data);
        })
        .catch(() => {
          const url = `https://raw.git.faithlife.dev/Build/Configuration/master/${projectish}.json`;
          http
            .read({
              url,
              headers: {
                'Accept': 'application/vnd.github.v3.raw',
                'Authorization': 'token ' + gitHubAccessToken
              }
            })
            .then(data => {
              console.log(`Read configuration from ${url}`);
              resolve(data);
            })
            .catch(err => {
              console.error('Couldn\'t read Leeroy configuration from GitHub; is your GitHub PAT correct?');
              keytar.deletePassword(keytarService, keytarAccount)
                .then(() => reject(err));
            });
        });
    });
  });
}
