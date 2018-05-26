#!/usr/bin/env node
import http from 'q-io/http';
import fs from 'q-io/fs';
import { exec } from 'child_process';
import os from 'os';
import argparse from 'argparse';

const gitPath = Promise.resolve('git');
const home = process.platform === 'darwin' ? process.env.HOME : process.env.HOMEDRIVE + process.env.HOMEPATH;

const configFileName = '.clonejs';
const version = '0.8.0';

Promise.resolve(process.argv)
  .then(() => {
      return readLeeroyConfig();
  })
  .then(configName => {
    const options = { configName };

    if (process.argv.length > 2 || !configName) addOptionsFromCommandLineArguments(options);

    console.log(`Getting ${options.configName}`);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return Promise.resolve(fetchRemoteConfiguration(options.configName)).then(config => {
      options.config = config;
      return options;
    });
  })
  .then(options => {
    return options.save ?
      Promise.resolve(createLeeroyConfig(options.configName)).then(() => { return options; }) :
      options;
  })
  .then(options => {
    const createPromise = createSolutionInfos();
    return createPromise.then(() => {
      const promises = Object.keys(options.config.submodules).map(name => processSubmodule(name, options));
      const firstIteration = Promise.all(promises);
      return Promise.all([firstIteration, options]);
    });
  })
  .then(([unprocessedSubmodules, options]) => {
    // One recursive iteration is all we need; options are either fully resolved at this point, or they never will be.
    return Promise.all(unprocessedSubmodules.map(x => { if (x) processSubmodule(x, options); }));
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

function createLeeroyConfig(configName) {
  const settings = { leeroyConfig: configName };
  return fs.write(configFileName, JSON.stringify(settings));
}

function fetchRemoteConfiguration(configName) {
  return http.read(`https://git/raw/Build/Configuration/master/${configName}.json`)
    .catch(() => {
      throw new Error(`Couldn't download Leeroy config file: ${configName}`);
    })
    .then(data => {
      const config = JSON.parse(data);
      if (!config.submodules) throw new Error(`Leeroy config file is missing 'submodules' configuration.`);
      return config;
    });
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

function processSubmodule(name, options) {
  const branch = options.config.submodules[name];

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
      (!exists ?
        clone(submodule) :
        checkRemote(submodule)
          .then(() => fetchOrigin(submodule))
          .then(() => checkBranch(submodule)))
      .then(() => pull(submodule, options))
    )
    .then(wasProcessed => {
      if (wasProcessed) console.log(submodule.output());
      return !wasProcessed ? name : null;
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
  return exec_git('status', { cwd: submodule.repo })
    .then(statusOutput => {
      const detachedHead = statusOutput.length > 13 && statusOutput.substring(0, 13) === "HEAD detached";
      return detachedHead ?
        Promise.resolve('Detached HEAD') :
        exec_git('symbolic-ref --short -q HEAD', { cwd: submodule.repo });
      })
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

function pull(submodule, options) {
  const pullAction = options.revisionData && !options.revisionData.date ? pullByRevision(submodule, options) :
    options.date ? pullByDate(submodule, options.date) :
    options.tag ? pullByTag(submodule, options.tag) :
    exec_git(`pull --rebase origin ${submodule.branch}`, { cwd: submodule.repo }).then(output => { return { output, success: true }; });
  return pullAction
    .then(result => {
      return result.success ?
        Promise.all([result, exec_git('submodule update --init --recursive', { cwd: submodule.repo })]) :
        [result];
    })
    .then(([result]) => {
      submodule.log(`${result.output}`, 2);
      return result.success;
    });
}

function pullByTag(submodule, tag) {
  return exec_git('tag -l', { cwd: submodule.repo })
    .then(tagOutput => {
      const hasTag = tag && tagOutput.split(/\r?\n/).indexOf(tag) >= 0;
      if (hasTag) {
        return exec_git(`checkout ${tag}`, { cwd: submodule.repo })
          .then(() => `Checked out ${tag}.`);
      } else {
        submodule.log(`Tag (${tag}) does not exist. Falling back to pull --rebase.`, 2);
        return exec_git(`pull --rebase origin ${submodule.branch}`, { cwd: submodule.repo });
      }
    })
    .then(output => { return { output, success: true }; });
}

function pullByDate(submodule, date) {
  const dateString = date.toUTCString();
  return exec_git(`rev-list -n 1 --before="${dateString}" origin/${submodule.branch}`, { cwd: submodule.repo })
    .then(revision => {
      if (!revision) throw new Error(`Invalid date: ${dateString} for ${submodule.rep}/${submodule.branch}`);
      return Promise.all([`Checked out ${revision} [by date].`, exec_git(`checkout ${revision}`, { cwd: submodule.repo })]);
    })
    .then(([output]) => { return { output, success: true }; });
}

function pullByRevision(submodule, options) {
  const revision = options.revisionData.revision;
  return exec_git(`show ${revision} --no-patch --pretty=format:%cd`, { cwd: submodule.repo })
    .then(date => {
        options.date = new Date(date);
        options.revisionData.date = options.date;
        return Promise.all([`Checked out ${revision}.${os.EOL}Keying off of ${date}.`, exec_git(`checkout ${revision}`, { cwd: submodule.repo })])
          .then(output => { return { output, success: true }; });
    })
    .catch(() => { return { output: `Failed to find ${options.revisionData.revision}`, success: false }; });
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

function addOptionsFromCommandLineArguments(options) {
  const parser = new argparse.ArgumentParser({
    version,
    addHelp: true,
    description: 'Clones git repositories from a Leeroy configuration.'
  });

  const subparsers = parser.addSubparsers({
    title: 'subcommands',
    dest: 'command'
  });

  const commands = createCommands();
  commands.map(x => { x.initializeParsers(parser, subparsers); });

  const args = parser.parseArgs();
  commands.map(x => {
    if (x.name !== args.command) return;
    if (x.validateArgs) x.validateArgs(args);
    x.addOptions(args, options);
  });
}

function createCommands()
{
  return [
    {
      name: 'clone',
      initializeParsers: (parser, subparsers) => {
        const cloneParser = subparsers.addParser('clone', {
          addHelp: true,
          help: `Clones a configuration. The configuration name will be saved to the local ${configFileName} file.  If the file exists, it will be overwritten.`
        });
        cloneParser.addArgument(['config'], {
          help: 'The Leeroy configuration name.'
        });
      },
      addOptions: (args, options) => {
        options.configName = args.config;
        options.save = true;
      }
    },
    {
      name: 'rollback',
      initializeParsers: (parser, subparsers) => {
        const rollbackParser = subparsers.addParser('rollback', {
          addHelp: true,
          help: 'Rollback all repositories in the configuration to a given tag, date, or revision.'
        });
        rollbackParser.addArgument(['-t', '--tag'], {
          help: 'For each repository in the configuration, checkout at the provided tag.  If the tag is missing, do nothing.'
        });
        rollbackParser.addArgument(['-d', '--date'], {
          help: 'For each repository in the configuration, checkout at the most recent revision before the given date.'
        });
        rollbackParser.addArgument(['-r', '--revision'], {
          help: 'Checkout the repository the revision is associated with to the revision. Checkout all other repositories to the date the commit was pushed.'
        });
      },
      validateArgs: args => {
        if (!args.tag && !args.date && !args.revision) throw new Error('Must provide one of --tag, --date, or --revision.');
        if (args.tag && args.date) throw new Error(`Can't provide both --tag and --date.`);
        if (args.tag && args.revision) throw new Error(`Can't provide both --tag and --revision.`);
        if (args.date && args.revision) throw new Error(`Can't provide both --date and --revision.`);
      },
      addOptions: (args, options) => {
        options.tag = args.tag;
        if (args.date)
        {
          const parseResult = Date.parse(args.date);
          if (!parseResult) throw new Error(`Invalid date specified: ${args.date}`);
          options.date = new Date(parseResult);
        }
        if (args.revision) options.revisionData = { revision: args.revision };
      }
    }
  ];
}
