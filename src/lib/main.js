"use strict";

var _ = Npm.require('lodash'),
    path = Npm.require('path'),
    Glob = Npm.require('glob').Glob,
    // TODO Externalize these to a conf file
    SOURCE_CODE_FILE_EXTENSIONS = ['js', 'coffee'],
    ABSOLUTE_TESTS_DIR = process.env.PWD + '/tests';

function frameworkForFile (file) {
    return _.filter(Velocity.frameworks, function (framework, name) {
        return framework.glob.minimatch.match(file);
    })[0];
}

Velocity = {

    frameworks: {},

    registerFramework: function (name, options, callback) {
        if (callback == null && 'function' === typeof options) {
            callback = options;
            options = {};
        }

        options = _.extend({}, options, {
            watch: '**/*-' + name + '.{' + SOURCE_CODE_FILE_EXTENSIONS.join(',') + '}'
        });

        var framework = {
            name: name,
            options: options,
            run: Meteor.bindEnvironment(callback),
            glob: null,
            reset: function () {
                framework.glob = new Glob(path.join(ABSOLUTE_TESTS_DIR, framework.options.watch), {
                    sync: true,
                    cwd: ABSOLUTE_TESTS_DIR
                });
                _.forEach(framework.glob.found, function (file) {
                    VelocityTestFiles.insert({
                        _id: file,
                        name: path.basename(file),
                        absolutePath: file,
                        relativePath: path.relative(ABSOLUTE_TESTS_DIR, file),
                        targetFramework: name,
                        lastModified: Date.now()
                    });
                });
            }
        };

        Velocity.frameworks[name] = framework;
        framework.reset();
        Meteor.startup(framework.run);
    },

    initWatcher: function () {
        return Npm.require('chokidar').watch(ABSOLUTE_TESTS_DIR, {ignoreInitial: true, ignored: /[\/\\]\./})
            .on('add', Meteor.bindEnvironment(function (filePath) {

                console.log('File', 'has been added', filePath);

                filePath = path.normalize(filePath);

                var relativeDir = path.relative(ABSOLUTE_TESTS_DIR, path.dirname(filePath)),
                    filename = path.basename(filePath),
                    framework = frameworkForFile(filePath);

                if (framework) {
                    VelocityTestFiles.insert({
                        _id: filePath,
                        name: filename,
                        absolutePath: path.join(ABSOLUTE_TESTS_DIR, relativeDir, filename),
                        relativePath: path.join(relativeDir, filename),
                        targetFramework: framework.name,
                        lastModified: Date.now()
                    });
                    framework.run();
                }
            }))
            .on('change', Meteor.bindEnvironment(function (filePath) {
                console.log('File', filePath, 'has been changed');
                var filename = path.basename(filePath),
                    framework = frameworkForFile(filePath);
                VelocityTestFiles.update(filePath, { $set: {lastModified: Date.now()}});
                if (framework) framework.run();
            }))
            .on('unlink', Meteor.bindEnvironment(function (filePath) {
                console.log('File', filePath, 'has been removed');
                // If we only remove the file, we also need to remove the test results for just that file. This required
                // changing the postResult API and we could do it, but the brute force method of reset() will do the trick
                // until we want to optimize
    //            VelocityTestFiles.remove(filePath);
                Velocity.reset();
                _.forEach(Velocity.frameworks, function (framework) {
                    framework.run();
                });
            }));
    },

    reset: function () {
        if (Velocity.watcher) Velocity.watcher.close();
        VelocityTestFiles.remove({});
        VelocityTestReports.remove({});
        VelocityAggregateReports.remove({});
        VelocityAggregateReports.insert({
            _id: 'result',
            name: 'Aggregate Result',
            result: 'pending'
        });
        Velocity.watcher = Velocity.initWatcher();
        _.forEach(Velocity.frameworks, function (framework) {
            framework.reset();
        });
    },

    updateAggregateReports: function () {
        if (!VelocityTestReports.findOne({result: ''})) {
            VelocityAggregateReports.update('result', {$set: { result: VelocityTestReports.findOne({result: 'failed'}) ? 'failed' : 'passed'}});
        }
    },

    resetReports: function (options) {
        var query = {};
        if (options.framework) {
            query.framework = options.framework;
        }
        if (options.notIn) {
            query = _.assign(query, {_id: {$nin: options.notIn }});
        }
        VelocityTestReports.remove(query);
        Velocity.updateAggregateReports();
    },

    postLog: function (options) {
        if (!options || !options.type || !options.message || !options.framework) {
            throw new Error('type, message and framework are required fields.')
        }
        VelocityLogs.insert({
            timestamp: options.timestamp ? options.timestamp : Date.now(),
            type: options.type,
            message: options.message,
            framework: options.framework
        });
    },

    postResult: function (options) {

        if (!options || !options.id || !options.name || !options.framework || !options.result) {
            throw new Error('id, name, framework and result are required fields.')
        }
        var result = {
            name: options.name,
            framework: options.framework,
            result: options.result
        };

        _.each([
            'timestamp',
            'time',
            'async',
            'timeOut',
            'pending',
            'failureType',
            'failureMessage',
            'failureStackTrace',
            'ancestors'
        ], function (option) {
            result[option] = options[option] ? options[option] : '';
        });

        VelocityTestReports.upsert(options.id, {$set: result});
        Velocity.updateAggregateReports();
    }
};


Meteor.methods({
    reset: Velocity.reset,
    resetReports: Velocity.resetReports,
    postLog: Velocity.postLog,
    postResult: Velocity.postResult
});

Meteor.call('reset');