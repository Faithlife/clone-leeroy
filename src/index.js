#!/usr/bin/env node
import http from 'q-io/http';
import fs from 'q-io/fs';
import { exec } from 'child_process';
import os from 'os';

const gitPath = Promise.resolve('git');
const home = process.platform === 'darwin' ? process.env.HOME : process.env.HOMEDRIVE + process.env.HOMEPATH;

const configFileName = '.clonejs';

Promise.resolve(process.argv)
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
    .then(exists => {
      if (!exists) return fs.write(info.name, info.data);
    })
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
    remoteUrl: `git@git:${owner}/${repo}.git`,
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
  return exec_git('symbolic-ref --short -q HEAD', { cwd: submodule.repo })
    .then(currentBranch => {
      if (currentBranch !== submodule.branch) {
        submodule.log(`Switching branches from ${currentBranch} to ${submodule.branch}`, 2);
        return exec_git(`branch --list -q --no-color ${submodule.branch}`, { cwd: submodule.repo })
          .then(existingTargetBranch => {
            if (existingTargetBranch !== submodule.branch) {
              return exec_git(`checkout -B ${submodule.branch} --track origin/${submodule.branch}`, { cwd: submodule.repo });
            } else {
              return exec_git(`checkout ${submodule.branch}`, { cwd: submodule.repo });
            }
          });
        }
      });
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

      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      http
        .read(projectish)
        .then(data => {
          console.log(`Read configuration from ${projectish}`);
          resolve(data);
        })
        .catch(() => {
          const url = `https://git/raw/Build/Configuration/master/${projectish}.json`;
          http
            .read(url)
            .then(data => {
              console.log(`Read configuration from ${url}`);
              resolve(data);
            })
            .catch(reject);
        });
    });
  });
}
