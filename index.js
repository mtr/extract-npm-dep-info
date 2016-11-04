#! /usr/bin/env node

var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var program = require('commander');
var npmLicenseCrawler = require('npm-license-crawler');

var version = '1.0.0';

program
    .version(version)
    .usage('[options]')
    .option('--strict', 'Only show packages that are listed as dependencies.')
    .option('--extra <extra-file>',
        'Augment with extra information from file')
    .option('-o, --output [output file]',
        'Write extracted info to file');


function isPackageDependency(name, packageJson) {
    return _.has(packageJson.dependencies, name);
}

function parseCrawlerResults(packageJson, licences) {
    var dependencies = _.transform(licences, function _foo(result, value, key) {
        var parts = key.split('@'),
            name = parts[0],
            version = parts[1];

        if (!program.strict || isPackageDependency(name, packageJson)) {
            result.push({
                name: name,
                version: version,
                licenses: value.licenses,
                repository: value.repository,
                licenseUrl: value.licenseUrl
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

function output(data) {
    if (program.output) {
        json = JSON.stringify(data);
        fs.writeFileSync(path.join(__dirname, program.output), json);
    } else {
        console.log(data);
    }
}

function parseDependencies() {
    program.parse(process.argv);

    var jsonString = fs.readFileSync(path.join(__dirname, 'package.json'));
    var packageJson = JSON.parse(jsonString);

    // console.log(packageJson);

    var origConsoleLog = console.log;
    console.log = function _silencedConsoleLog() {
    };  // Disable log.

    var res = npmLicenseCrawler.dumpLicenses({
        start: '.',
        exclude: [],
        dependencies: true,
        json: false,
        csv: false,
        gulp: false
    }, function (error, results) {
        console.log = origConsoleLog;  // Enable log.
        var data = parseCrawlerResults(packageJson, results);

        output(data);
    });
}

parseDependencies();
