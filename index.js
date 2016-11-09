#! /usr/bin/env node

var _ = require('lodash');
var chalk = require('chalk');
var fs = require('fs');
var path = require('path');
var program = require('commander');
var Promise = require('promise');
var npmLicenseCrawler = require('npm-license-crawler');
var request = require('request');

var version = '1.0.0';

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

var _ignoreGitHttpPrefixRegEx = /^git\+(https?.*)$/;
var _ignoreGitSshPrefixRegEx = /^git\+ssh:\/\/([^@]+)@?(.*)$/;
var _replaceGitHubTypoRegEx = /^https:\/\/wwwhub\.com\/(.*)$/;

function _cleanupUrls(str) {
    if (typeof str === 'string') {
        return str.replace(_ignoreGitHttpPrefixRegEx, '$1')
            .replace(_ignoreGitSshPrefixRegEx, 'https://$2')
            .replace(_replaceGitHubTypoRegEx, 'https://github.com/$1');
    }
    return str;
}

var _licenseGuesses = [
    'LICENSE',
    'LICENSE.txt',
    'LICENSE.md'
];

var createHypothesisCrawler = function (guessUrl, i, crawlers) {
    return new Promise(function (resolve, reject) {

        var crawler = request.head(guessUrl,
            function _handleResponse(error, response, body) {
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
                    }
                }

                if (typeof body === 'string' && !body.match(/<html>/)) {
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
                reject('Crawler for ' + guessUrl + ' reached an unknown state');
            })
            .on('abort', function _onAbort() {
                /*
                 console.log('Aborted #' + i + ':', guessUrl);
                 */
                resolve({
                    isValid: false,
                    url: guessUrl,
                    reason: 'Aborted #' + i + ':'
                }, guessUrl);
            });

        crawlers.push(crawler);
    });
};

function _guessLicenseUrl(urlBase) {
    var promises = [];
    var crawlers = [];

    for (var i = 0; i < _licenseGuesses.length; i++) {
        const guessUrl = urlBase + _licenseGuesses[i];

        promises.push(createHypothesisCrawler(guessUrl, i, crawlers));
    }

    return Promise.all(promises)
        .then(function _filterLicenses(results) {
            return Promise.resolve(_.filter(results, ['isValid', true]));
        });
}

const _removeSingleEndlines = /[^\r\n]\r?\n([^\r\n])/g;

function getLicenseText(url) {
    return new Promise(function (resolve, reject) {
        request(url, function _returnLicenseText(error, response, body) {
            if (!error && typeof body === 'string' && !body.match(/<html>/)) {
                resolve(body.replace(_removeSingleEndlines, '$1'));
            } else {
                resolve(null);
            }
        });
    });
}

var _licenceRegEx = /license\.?(txt|md)?$/i;

function addLicenseText(dependency) {
    return new Promise(function (resolve, reject) {
        if (!dependency.licenseUrl.match(_licenceRegEx)) {
            if (dependency.licenseUrl === dependency.repository) {
                _guessLicenseUrl(dependency.licenseUrl + '/raw/master/')
                    .then(function _onFulfilled(results) {
                        dependency.licenseUrl = _.first(results).url;

                        getLicenseText(dependency.licenseUrl).then(function _setLicenseText(value) {
                            dependency.licenseText = value;
                            resolve(value);
                        });
                    }, function _onRejected(results) {
                        dependency.licenseUrl = null;
                        resolve();
        })  ;
            } else {
                consoleLog(chalk.red('Don\'t know how to handle the licenseUrl value'),
                    chalk.cyan(dependency.licenseUrl));
                resolve();
            }
        } else {
            getLicenseText(dependency.licenseUrl).then(function _setLicenseText(value) {
                dependency.licenseText = value;
                resolve(value);
            });
        }
    });
}

function parseCrawlerResults(packageJson, licences) {
    return new Promise(function (resolve, reject) {
        var dependencies = _.transform(licences,
            function _dependencyTransformer(result, value, key) {
                var parts = key.split('@'),
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

        Promise.all(_.map(dependencies, addLicenseText))
            .then(function onResolve(promises) {
                var now = new Date();

                var args = program.rawArgs.splice(2);

                resolve({
                    name: packageJson.name,
                    version: packageJson.version,
                    comment: 'Dependency information automatically extracted with "' +
                    program.name() + ' ' + args.join(' ') + '"',
                    generated: now.toLocaleString(),
                    dependencies: dependencies
                });
            }, function onRejected(reason) {
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
        var json = JSON.stringify(data, replaceUndefinedByNull);
        var destinationPath = path.join(process.cwd(), program.output);
        fs.writeFileSync(destinationPath, json);
    } else {
        console.log(data);
    }
}

function getDependenciesExtra(packageJson) {
    var inlined,
        external;

    if (_.has(packageJson, _dependenciesExtraField)) {
        consoleLog(chalk.cyan('Will augment dependency entries with info from'),
            chalk.green(_dependenciesExtraField),
            chalk.cyan('field in'), chalk.magenta('package.json'));
        inlined = packageJson[_dependenciesExtraField];
    }
    if (program.extra) {
        var extraPath = path.join(process.cwd(), program.extra);
        consoleLog(chalk.cyan('Will use info from'), chalk.magenta(extraPath),
            chalk.cyan('for augmenting the dependency entries'));
        var extraString = fs.readFileSync(extraPath);
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

function extendWithExtraInfo(data, dependenciesExtra, accumulatedExtra) {
    _.each(data.dependencies, function _addExtraInfo(entry) {
        var extra;
        if (_.has(dependenciesExtra, entry.name)) {
            extra = dependenciesExtra[entry.name];
        } else {
            consoleLog(chalk.yellow('Warning: No augmentation data found for',
                chalk.green(entry.name), chalk.yellow('package')));
            extra = {};
        }

        _.merge(entry, extra, accumulatedExtra);
    });
}

function parseDependencies() {
    program.parse(process.argv);

    var packageJsonPath = path.join(process.cwd(), 'package.json');
    consoleLog(chalk.cyan('Will read package.json from'),
        chalk.magenta(packageJsonPath));

    var jsonString = fs.readFileSync(packageJsonPath);
    var packageJson = JSON.parse(jsonString);
    var dependenciesExtra = getDependenciesExtra(packageJson);
    var accumulatedExtra = {};

    if (program.accumulate) {
        accumulatedExtra = getAccumulatedExtraFields(dependenciesExtra);
    }

    var origConsoleLog = console.log;
    console.log = function _silencedConsoleLog() {
    };  // Disable log.

    npmLicenseCrawler.dumpLicenses({
        start: '.',
        exclude: [],
        dependencies: true,
        json: false,
        csv: false,
        gulp: false
    }, function (error, results) {
        console.log = origConsoleLog;  // Enable log.
        parseCrawlerResults(packageJson, results)
            .then(function _onResolve(data) {
                if (dependenciesExtra) {
                    extendWithExtraInfo(data, dependenciesExtra, accumulatedExtra);
                }
                output(data);
            }, function onRejected(reason) {
                consoleLog(chalk.red(reason));
            });

    });
}

parseDependencies();
