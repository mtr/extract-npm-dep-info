#! /usr/bin/env node

const _ = require('lodash');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const program = require('commander');
const Promise = require('promise');
const npmLicenseCrawler = require('npm-license-crawler');
const request = require('request');
// require('promise/lib/rejection-tracking').enable();  // <-- For debugging during development only.

const version = '1.1.0';

const _dependenciesExtraField = 'dependenciesExtra';

program
    .version(version)
    .usage('[options]')
    .option('--strict', 'Only show packages that are listed as dependencies.')
    .option('-e, --extra <extra-file>',
        'Augment with extra information from file, if not supplied as ' +
        '"' + _dependenciesExtraField + '" in package.json.')
    .option('-a, --no-accumulate',
        'The default is to augment every package with the accumulated set of ' +
        'extra fields, from all "' + _dependenciesExtraField + '" fields, even if ' +
        'they were not supplied per package.  This turns that behavior off.')
    .option('-o, --output [output file]', 'Write extracted info to file')
    .option('-q, --quiet', 'No output to console, except the generated data');


function consoleLog(args) {
    if (!program.quiet) {
        Function.prototype.apply.apply(console.log, [console, arguments]);
    }
}

function isPackageDependency(name, dependency, packageJson) {
    return _.has(packageJson.dependencies, name) &&
        dependency.parents === packageJson.name;
}

const _ignoreGitHttpPrefixRegEx = /^git\+(https?.*)$/;
const _ignoreGitSshPrefixRegEx = /^git\+ssh:\/\/([^@]+)@?(.*)$/;
const _replaceGitHubTypoRegEx = /^https:\/\/wwwhub\.com\/(.*)$/;

function _cleanupUrls(str) {
    if (_.isString(str)) {
        return str
            .replace(_ignoreGitHttpPrefixRegEx, '$1')
            .replace(_ignoreGitSshPrefixRegEx, 'https://$2')
            .replace(_replaceGitHubTypoRegEx, 'https://github.com/$1');
    }
    return str;
}

const _licenseGuesses = [
    'LICENSE',
    'LICENSE.txt',
    'LICENSE.md'
];

function createHypothesisCrawler(guessUrl, i, crawlers) {
    return new Promise(function (resolve, reject) {

        const crawler = request.head(guessUrl, (error, response, body) => {
            if (error) {
                consoleLog(chalk.red('HTTP request error:', error));
                resolve({
                    isValid: false,
                    url: guessUrl,
                    reason: 'HTTP request error: ' + error
                });
                return;
            }

            if (response) {
                /*
                 console.log('guessUrl', guessUrl);
                 console.log('response', response.request.href);
                 console.log('response.statusCode', response.statusCode);
                 */

                if (response.statusCode === 404) {
                    resolve({
                        isValid: false,
                        url: guessUrl,
                        reason: '404 Not found.'
                    });
                    return;
                } else {
                    // console.log('guessUrl', guessUrl);
                    // console.log('response', response.request.href);
                    // console.log('response.statusCode', response.statusCode);
                }
            }

            if (_.isString(body) && !body.match(/<html>/)) {
                /*
                 console.log('body #' + i, body);
                 */
                resolve({
                    isValid: true,
                    url: guessUrl,
                    actualUrl: response.request.href
                });

                for (var k = 0; k < crawlers.length; k++) {
                    if (k !== i) {
                        crawlers[k].abort();
                    }
                }
                return;
            }
            reject('Crawler for ' + guessUrl + ' reached an unknown state.');
        })
            .on('abort', function _onAbort() {
                resolve({
                    isValid: false,
                    url: guessUrl,
                    reason: 'Aborted #' + i + ':'
                }, guessUrl);
            });

        crawlers.push(crawler);
    });
}

function _guessLicenseUrl(urlBase) {
    const promises = [];
    const crawlers = [];

    for (let i = 0; i < _licenseGuesses.length; i++) {
        const guessUrl = urlBase + _licenseGuesses[i];

        promises.push(createHypothesisCrawler(guessUrl, i, crawlers));
    }

    return Promise.all(promises)
        .then((results) => {
            const value = _.filter(results, ['isValid', true]);
            return Promise.resolve(value);
        }, (reason) => {
            consoleLog('GuessLicenseUrl: Rejected:', reason);
            Promise.reject(reason);
        });
}

const gitHubBlobRegExp = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.*)/;

function _fixGitHubUrl(url) {
    return url.match(gitHubBlobRegExp) ?
        url.replace(gitHubBlobRegExp, 'https://raw.githubusercontent.com/$1/$2/$3') : url;
}

const _removeSingleEndlines = /([^\r\n])\r?\n([^\r\n])/g;

function getLicenseText(url) {
    url = _fixGitHubUrl(url);
    return new Promise(function (resolve, reject) {
        request(url, {}, (error, response, body) => {
            // console.log('error, response, body', error, response, body);
            // consoleLog('typeof body', typeof body);
            if (!error && _.isString(body) && !body.match(/<html>/)) {
                const result = !body.match(/\/\*/) ?
                    body.replace(_removeSingleEndlines, '$1 $2') : body;
                resolve(result);
            } else {
                // consoleLog(`* Received error for (${url}): error=${error}, body=${body}`);
                // consoleLog(`* Received error for (${url}):`);
                resolve();
            }
        });
    });
}

const _licenceRegEx = /license.*\.?(txt|md)?$/i;

function addLicenseText(dependency) {
    return new Promise((resolve, reject) => {
        function _handleReject(reason) {
            consoleLog(chalk.red(`Could not get license text for ${dependency.name} (${dependency.repository}): ${reason}`));
            dependency.licenseUrl = null;
            dependency.licenseText = null;
            resolve();
        }

        consoleLog(
            chalk.cyan(`Looking up license text for`),
            chalk.green(`${dependency.name} (${dependency.repository})`)
        );
        if (dependency.licenseUrl.match(_licenceRegEx)) {
            consoleLog(chalk.cyan(`Will check plain URL for ${dependency.name}: ${dependency.licenseUrl}.`));
            getLicenseText(dependency.licenseUrl)
                .then((value) => {
                    dependency.licenseText = value;
                    resolve(value);
                }, _handleReject);
        } else {
            if (dependency.licenseUrl === dependency.repository) {
                _guessLicenseUrl(dependency.licenseUrl + '/raw/master/')
                    .then((results) => {
                        if (results.length) {
                            dependency.licenseUrl = _.first(results).url;

                            getLicenseText(dependency.licenseUrl)
                                .then(function _setLicenseText(value) {
                                    dependency.licenseText = value;
                                    resolve(value);
                                }, _handleReject);
                        } else {
                            consoleLog(chalk.red(`Could not find license URL for "${dependency.name}" (${dependency.repository})`));
                            resolve();
                        }
                    }, _handleReject);
            } else {
                const urlBase = dependency.repository + '/raw/master/';
                // consoleLog(`Checking ${urlBase} instead of ${dependency.licenseUrl}`);
                _guessLicenseUrl(urlBase)
                    .then((results) => {
                        // consoleLog('results', results);
                        if (results.length) {
                            dependency.licenseUrl = _.first(results).url;

                            getLicenseText(dependency.licenseUrl)
                                .then(function _setLicenseText(value) {
                                    dependency.licenseText = value;
                                    resolve(value);
                                }, _handleReject);
                        } else {
                            consoleLog(chalk.red(`Could not find license URL for "${dependency.name}" (${dependency.repository})`));
                            resolve();
                        }

                    });

                consoleLog(chalk.red('Don\'t know how to handle the licenseUrl value'),
                    chalk.cyan(dependency.licenseUrl));
                resolve();
            }
        }
    });
}

function extendWithExtraInfo(dependencies, dependenciesExtra, accumulatedExtra) {
    return _.map(dependencies, function _addExtraInfo(entry) {
        let extra;
        if (_.has(dependenciesExtra, entry.name)) {
            extra = dependenciesExtra[entry.name];
        } else {
            consoleLog(chalk.yellow('Warning: No augmentation data found for',
                chalk.green(entry.name), chalk.yellow('package')));
            extra = {};
        }

        return _.defaults({}, extra, entry, accumulatedExtra);
    });
}

function parseCrawlerResults(packageJson, licences, dependenciesExtra, accumulatedExtra) {
    return new Promise(function (resolve, reject) {
        let dependencies = _.transform(licences, (result, value, key) => {
            const parts = key.split('@'),
                version = parts.pop(),
                name = parts.join('@');

            if (!program.strict || isPackageDependency(name, value, packageJson)) {
                result.push({
                    name: name,
                    version: version,
                    licenses: value.licenses,
                    repository: _cleanupUrls(value.repository),
                    licenseUrl: _cleanupUrls(value.licenseUrl),
                    parents: value.parents
                });
            }
        }, []);

        if (dependenciesExtra) {
            dependencies = extendWithExtraInfo(dependencies, dependenciesExtra, accumulatedExtra);
        }

        Promise.all(_.map(dependencies, addLicenseText))
            .then((promises) => {
                const now = new Date();
                const args = program.rawArgs.splice(2);

                resolve({
                    name: packageJson.name,
                    version: packageJson.version,
                    comment: 'Dependency information automatically extracted with "' +
                    program.name() + ' ' + args.join(' ') + '"',
                    generated: now.toLocaleString(),
                    dependencies: dependencies
                });
            }, (reason) => {
                reject(reason);
            });
    });
}

function replaceUndefinedByNull(key, value) {
    if (_.isUndefined(value)) {
        return null;
    }
    return value;
}

function output(data) {
    if (program.output) {
        const json = JSON.stringify(data, replaceUndefinedByNull);
        const destinationPath = path.join(process.cwd(), program.output);
        fs.writeFileSync(destinationPath, json);
    } else {
        consoleLog(data);
    }
}

function getDependenciesExtra(packageJson) {
    let inlined,
        external;

    if (_.has(packageJson, _dependenciesExtraField)) {
        consoleLog(chalk.cyan('Will augment dependency entries with info from'),
            chalk.green(_dependenciesExtraField),
            chalk.cyan('field in'), chalk.magenta('package.json'));
        inlined = packageJson[_dependenciesExtraField];
    }
    if (program.extra) {
        const extraPath = path.join(process.cwd(), program.extra);
        consoleLog(chalk.cyan('Will use info from'), chalk.magenta(extraPath),
            chalk.cyan('for augmenting the dependency entries'));
        const extraString = fs.readFileSync(extraPath);
        external = JSON.parse(extraString);
    }
    if (inlined && external) {
        consoleLog(chalk.cyan('Info from'), chalk.magenta(extraPath),
            chalk.cyan('will override info from'),
            chalk.green(_dependenciesExtraField), chalk.cyan('field in'),
            chalk.magenta('package.json'), chalk.cyan('in case of collisions'))
    }

    if (_.isUndefined(external)) {
        return inlined;
    }
    if (_.isUndefined(inlined)) {
        return external;
    }
    return _.merge(inlined, external);
}

function getAccumulatedExtraFields(dependenciesExtra) {
    return _.transform(dependenciesExtra, function _aggregateKeys(result, dependency) {

        _.each(dependency, function _seeKey(value, key) {
            result[key] = undefined;
        });
    }, {});
}

function parseDependencies() {
    program.parse(process.argv);

    const packageJsonPath = path.join(process.cwd(), 'package.json');
    consoleLog(chalk.cyan('Will read package.json from'),
        chalk.magenta(packageJsonPath));

    const jsonString = fs.readFileSync(packageJsonPath);
    const packageJson = JSON.parse(jsonString);
    const dependenciesExtra = getDependenciesExtra(packageJson);
    let accumulatedExtra = {};

    if (program.accumulate) {
        accumulatedExtra = getAccumulatedExtraFields(dependenciesExtra);
    }

    const origConsoleLog = console.log;
    console.log = function _silencedConsoleLog() {
    };  // Disable log.

    return new Promise((resolve, reject) => {
        npmLicenseCrawler.dumpLicenses({
            start: '.',
            exclude: [],
            dependencies: true,
            json: false,
            csv: false,
            gulp: false
        }, (error, results) => {
            console.log = origConsoleLog;  // Enable log.
            parseCrawlerResults(packageJson, results, dependenciesExtra, accumulatedExtra)
                .then((data) => {
                    output(data);
                    resolve();
                }, (reason) => {
                    consoleLog(chalk.red(`Parsing of crawled dependencies failed because: ${reason}`));
                    reject();
                });

        });
    });
}

try {
    parseDependencies()
        .then((value) => {
            consoleLog(chalk.green('Status: OK'));
        }, (reason) => {
            consoleLog(chalk.red('Status: Error'));
        });
} catch (wat) {
    consoleLog(chalk.red(`WAT?!: ${wat}`));
}
