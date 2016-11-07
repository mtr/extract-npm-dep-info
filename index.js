#! /usr/bin/env node

var _ = require('lodash');
var chalk = require('chalk');
var fs = require('fs');
var path = require('path');
var program = require('commander');
var npmLicenseCrawler = require('npm-license-crawler');

var version = '1.0.0';

program
    .version(version)
    .usage('[options]')
    .option('--strict', 'Only show packages that are listed as dependencies.')
    .option('-e, --extra <extra-file>',
        'Augment with extra information from file, if not supplied as ' +
        '"dependencies_extra" in package.json.')
    .option('-a, --no-accumulate',
        'The default is to augment every package with the accumulated set of ' +
        'extra fields, from all "dependencies_extra" fields, even if ' +
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

function parseCrawlerResults(packageJson, licences) {
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
                    repository: value.repository,
                    licenseUrl: value.licenseUrl,
                    parents: value.parents
                });
            }
        }, []);

    var now = new Date();

    var args = program.rawArgs.splice(2);

    return {
        name: packageJson.name,
        version: packageJson.version,
        comment: 'Dependency information automatically extracted with "' +
        program.name() + ' ' + args.join(' ') + '"',
        generated: now.toLocaleString(),
        dependencies: dependencies
    };
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
        fs.writeFileSync(path.join(__dirname, program.output), json);
    } else {
        console.log(data);
    }
}

function getDependenciesExtra(packageJson) {
    var inlined,
        external;

    if (_.has(packageJson, 'dependencies_extra')) {
        consoleLog(chalk.cyan('Will augment dependency entries with info from'),
            chalk.green('dependencies_extra'),
            chalk.cyan('field in'), chalk.magenta('package.json'));
        inlined = packageJson.dependencies_extra;
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
            chalk.green('dependencies_extra'), chalk.cyan('field in'),
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
        var data = parseCrawlerResults(packageJson, results);

        if (dependenciesExtra) {
            extendWithExtraInfo(data, dependenciesExtra, accumulatedExtra);
        }
        output(data);
    });
}

parseDependencies();
