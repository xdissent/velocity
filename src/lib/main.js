"use strict";

var _ = Npm.require('lodash'),
    fs = Npm.require('fs'),
    path = Npm.require('path'),
    chokidar = Npm.require('chokidar'),
    _ = Npm.require('lodash'),
    glob = Npm.require('glob'),
    DEBUG = !!process.env.VELOCITY_DEBUG,
    TEST_DIR = 'tests',
    _config,
    watcher;


DEBUG && console.log('PWD', process.env.PWD);

_config = _loadTestPackageConfigs();
DEBUG && console.log('velocity config =', JSON.stringify(_config, null, 2));

// kick-off everything
_reset(_config);



//////////////////////////////////////////////////////////////////////
// Meteor Methods
//

Meteor.methods({

  /**
   * Meteor method: reset
   * Re-init file watcher and clear all test results.
   *
   * @method reset
   */
  reset: function () {
    _reset(_config);
  },

  /**
   * Meteor method: resetReports
   * Clear all test results.
   *
   * @method resetReports
   * @param {Object} [options] Optional, specify specific framework to clear
   *                 and/or define a list of tests to keep.
   *                 ex.
   *                 {
   *                   framework: "jasmine-unit",
   *                   notIn: ['tests/auth-jasmine-unit.js']
   *                 }
   */
  resetReports: function (options) {
    var query = {};
    if (options.framework) {
      query.framework = options.framework;
    }
    if (options.notIn) {
      query = _.assign(query, {_id: {$nin: options.notIn }});
    }
    VelocityTestReports.remove(query);
    _updateAggregateReports();
  },

  /**
   * Meteor method: postLog
   * Log a method to the central Velocity log store.
   *
   * @method postLog
   * @param {Object} options Required parameters:
   *                   type - String
   *                   message - String
   *                   framework - String  ex. 'jasmine-unit'
   *                 
   *                 Optional parameters:
   *                   timestamp - Date
   */
  postLog: function (options) {
    var requiredFields = ['type', 'message', 'framework']

    _checkRequired (requiredFields, options);

    VelocityLogs.insert({
      timestamp: options.timestamp ? options.timestamp : Date.now(),
      type: options.type,
      message: options.message,
      framework: options.framework
    });
  },

  /**
   * Meteor method: postResult
   * Record the results of a test run.
   * 
   * @method postResult
   * @param {Object} data Required fields:
   *                   id - String
   *                   name - String
   *                   framework - String  ex. 'jasmine-unit'
   *                   result - String.  ex. 'failed', 'passed'
   *                 
   *                 Suggested fields:
   *                   timestamp
   *                   time
   *                   async
   *                   timeOut
   *                   pending
   *                   failureType
   *                   failureMessage
   *                   failureStackTrace
   *                   ancestors
   */
  postResult: function (data) {
    var requiredFields = ['id', 'name', 'framework', 'result'];

    data = data || {};

    _checkRequired (requiredFields, data);

    VelocityTestReports.upsert(data.id, {$set: data});
    _updateAggregateReports();
  }  // end postResult

});  // end Meteor methods




//////////////////////////////////////////////////////////////////////
// Private functions
//

/**
 * Ensures that each require field is found on the target object.
 * Throws exception if a required field is undefined, null or an empty string.
 *
 * @method _checkRequired
 * @param {Array} requiredFields - list of required field names
 * @param {Object} target - target object to check
 * @private
 */
function _checkRequired (requiredFields, target) {
  _.each(requiredFields, function (name) {
    if (!target[name]) {
      throw new Error("Required field '" + name + "' is missing." +
                      "Result not posted.")
    }
  })
}



/**
 * Locate all velocity-compatible test packages and return their config
 * data.
 *
 * @example
 *     // in `velocity-jasmine-unit` package's `smart.json`:
 *     {
 *       "name": "velocity-jasmine-unit",
 *       "description": "Velocity-compatible jasmine unit test package",
 *       "homepage": "https://github.com/xolvio/velocity-jasmine-unit",
 *       "author": "Sam Hatoum",
 *       "version": "0.1.1",
 *       "git": "https://github.com/xolvio/velocity-jasmine-unit.git",
 *       "test-package": true,
 *       "regex": "-jasmine-unit.(js|coffee)"
 *     }
 *
 * @method _loadTestPackageConfigs
 * @return {Object} Hash of test package names and their normalized config data.
 * @private
 */
function _loadTestPackageConfigs () {
  var pwd = process.env.PWD,
      smartJsons = glob.sync('packages/**/smart.json', {cwd: pwd}),
      testConfigDictionary;

  DEBUG && console.log('Check for test package configs...', smartJsons);

  testConfigDictionary = _.reduce(smartJsons, function (memo, smartJsonPath) {
    var contents,
        config;

    try {
      contents = fs.readFileSync(path.join(pwd, smartJsonPath));
      config = JSON.parse(contents);
      if (config.name && config.testPackage) {

        // add smart.json contents to our dictionary
        memo[config.name] = config

        if ('undefined' === typeof memo[config.name].regex) {
          // if test package hasn't defined an explicit regex for the file
          // watcher, default to the package name as a suffix. 
          // Ex. name = "mocha-web"
          //     regex = "-mocha-web.js"
          memo[config.name].regex = '-' + config.name + '.js';
        }

        // create a regexp obj for use in file watching
        memo[config.name]._regexp = new RegExp(memo[config.name].regex);
      }
    } catch (ex) {
      DEBUG && console.log('Error reading file:', smartJsonPath, ex);
    }
    return memo;
  }, {});

  return testConfigDictionary;
}  // end _loadTestPackageConfigs 

 
/**
 * Initialize the directory/file watcher.
 *
 * @method _initWatcher
 * @param {Object} config  See `_loadTestPackageConfigs`.
 * @private
 */
function _initWatcher (config) {
  var testDir,
      _watcher;

  testDir = path.join(process.env.PWD, TEST_DIR);

  _watcher = chokidar.watch(testDir, {ignored: /[\/\\]\./});


  _watcher.on('add', Meteor.bindEnvironment(function (filePath) {
    var relativePath,
        filename,
        targetFramework,
        data;

    filePath = path.normalize(filePath);

    DEBUG && console.log('File added:', filePath);

    filename = path.basename(filePath);

    targetFramework = _.find(config, function (framework) {
      return framework._regexp.test(filename);
    });

    if (targetFramework) {
      DEBUG && console.log(targetFramework.name, ' <= ', filePath);

      relativePath = filePath.substring(process.env.PWD.length);
      if (relativePath[0] === path.sep) {
        relativePath = relativePath.substring(1);
      }

      data = {
        _id: filePath,
        name: filename,
        absolutePath: filePath,
        relativePath: relativePath,
        targetFramework: targetFramework.name,
        lastModified: Date.now()
      };

      // ### TEMPORARY HACK
      if (targetFramework.name == 'velocity-jasmine-unit') {
        data.targetFramework = 'jasmine-unit';
      }

      //DEBUG && console.log('data', data);
      VelocityTestFiles.insert(data);
    }
  }));  // end watcher.on 'add'

  _watcher.on('change', Meteor.bindEnvironment(function (filePath) {
    DEBUG && console.log('File changed:', filePath);

    // Since we key on filePath and we only add files we're interested in,
    // we don't have to worry about inadvertently updating records for files
    // we don't care about.
    VelocityTestFiles.update(filePath, { $set: {lastModified: Date.now()}});
  }));

  _watcher.on('unlink', Meteor.bindEnvironment(function (filePath) {
    DEBUG && console.log('File removed:', filePath);
    // If we only remove the file, we also need to remove the test results for
    // just that file. This required changing the postResult API and we could 
    // do it, but the brute force method of reset() will do the trick until we 
    // want to optimize VelocityTestFiles.remove(filePath);
    _reset(config);
  }));

  return _watcher;
}  // end _initWatcher 


/**
 * Re-init file watcher and clear all test results.
 *
 * @method _reset
 * @param {Object} config  See `_loadTestPackageConfigs`.
 * @private
 */
function _reset (config) {
  if (watcher) {
    watcher.close();
  }

  VelocityTestFiles.remove({});
  VelocityTestReports.remove({});
  VelocityAggregateReports.remove({});
  VelocityAggregateReports.insert({
    _id: 'result',
    name: 'Aggregate Result',
    result: 'pending'
  });

  watcher = _initWatcher(config);
}

/**
 * If any one test has failed, mark the aggregate test result as failed.
 *
 * @method _updateAggregateReports 
 * @private
 */
function _updateAggregateReports () {
  var failedResult,
      result;

  if (!VelocityTestReports.findOne({result: ''})) {
    failedResult = VelocityTestReports.findOne({result: 'failed'})
    result = failedResult ?  'failed' : 'passed'

    VelocityAggregateReports.update('result', {$set: {result: result}});
  }
}
