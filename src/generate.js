#!/usr/bin/env node

var fs = require('fs');
var rimraf = require('rimraf');
var path = require('path');
var jsyaml = require('js-yaml');
var ZSchema = require('z-schema');
var validator = new ZSchema({
  ignoreUnresolvableReferences: true,
  ignoreUnknownFormats: true
});
var nameValidator = require('validator');

var config = require('./configurations'),
  logger = config.logger;
var zipdir = require('zip-dir');
var beautify = require('js-beautify').js;
const semver = require('semver');

var schemaV3 = fs.readFileSync(path.join(__dirname, './schemas/openapi-3.0.yaml'), 'utf8');
schemaV3 = jsyaml.safeLoad(schemaV3);


/**
 * Generates a valid name, according to value of nameFor.
 * @param {string} input - String to generate a name from.
 * @param {string} nameFor - possible values are controller, function, variable.
 */
function generateName(input, nameFor) {
  var chars = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789';
  var name = nameValidator.whitelist(input, chars)
  switch (nameFor) {
    case "controller":
      name += "Controller";
      break;
    case "function":
      name = "func" + name;
      break;
    case "variable":
      name = "var" + name;
      break;
    case undefined: //'nameFor' is undefined: just normalize
      break;
  }
  return name;
}

/**
 * Generates a valid value for package.json's name property:
 *    -All lowercase
 *    -One word, no spaces
 *    -Dashes and underscores allowed.
 * @param {object} title - Value of oasDoc.info.title.
 */
function getValidName(title) {
  return title.toLowerCase().replace(/[ ]/g, '-').replace(/[^0-9a-z-_]/g, "");
}

/**
 * Checks that version property matches X.X.X or tries to modify it to match it. In case it is not possible returns 1.0.0
 * @param {object} version - Value of oasDoc.info.version.
 */
function checkVersion(version) {
  var validVersion = semver.valid(semver.coerce(version));
  if (validVersion == null) {
    return "1.0.0";
  } else {
    return validVersion;
  }
}

function generateServer(file, cmd) {
  if (!file) {
    console.log("You must select an input specification file!");
  } else if (semver.lt(process.version, "v8.0.0")) {
    console.log("This program is not compatible with Node.js versions lower than v8.0.0 (current: " + process.version + ")");
  } else {
    try {
      try {
        var spec = fs.readFileSync(path.join('', file), 'utf8'); //TODO: valid fix?
        var oasDoc = jsyaml.safeLoad(spec);
        logger.info('Input oas-doc %s: %s', file, oasDoc);
      } catch (err) {
        logger.error("" + err);
        process.exit();
      }
      var err = validator.validate(oasDoc, schemaV3);
      if (err == false) {
        logger.error('oasDoc is not valid: ' + JSON.stringify(validator.getLastErrors()));
        process.exit();
      }
      var projectName = "nodejs-server-generated";
      if (cmd.projectName) { // TODO: fix issues with program parameters...is the camel-case conversion the problem?? see commander npm docu
        projectName = cmd.projectName;
        if (!/^[a-zA-Z0-9-_]+$/.test(projectName)) {
          logger.error("Name must only contain alphabetic characters, numbers and dashes.");
          process.exit();
        } else {
          logger.debug("Valid provided project name: " + projectName);
        }
      }

      if (!fs.existsSync(projectName)) {
        fs.mkdirSync(projectName);
      }
      process.chdir(projectName);

      /* create generic files */
      fs.copyFileSync(__dirname + '/auxiliary/README.md', './README.md');

      fs.copyFileSync(__dirname + '/auxiliary/index.js', './index.js');

      if (!fs.existsSync('.oas-generator')) {
        fs.mkdirSync('.oas-generator');
      }
      fs.writeFileSync('.oas-generator/VERSION', '1.0.0');

      if (!fs.existsSync('api')) {
        fs.mkdirSync('api');
      }
      fs.writeFileSync('./api/oas-doc.yaml', beautify(JSON.stringify(oasDoc), {
        indent_size: 2,
        space_in_empty_paren: true
      }));

      var package_raw = {
        "name": getValidName(oasDoc.info.title),
        "version": checkVersion(oasDoc.info.version),
        "description": "No description provided (generated by OAS Codegen)",
        "main": "index.js",
        "scripts": {
          "prestart": "npm install",
          "start": "node index.js"
        },
        "keywords": [
          "OAI"
        ],
        "license": "Unlicense",
        "private": true,
        "dependencies": {
          "body-parser": "^1.18.3",
          "express": "^4.16.3",
          "js-yaml": "^3.3.0",
          "oas-tools": "^2.1.0"
        }
      };
      fs.writeFileSync(process.cwd() + '/' + 'package.json', beautify(JSON.stringify(package_raw), {
        indent_size: 2,
        space_in_empty_paren: true
      }));

      /* create unique files: controllers and services */
      if (!fs.existsSync('controllers')) {
        fs.mkdirSync('controllers');
      }
      var paths = oasDoc.paths;
      var opId;
      var controllerName;
      var controller_files = [];
      for (var oasPath in paths) {
        for (var method in paths[oasPath]) {

          if (paths[oasPath][method].operationId != undefined) {
            opId = generateName(paths[oasPath][method].operationId, undefined);
          } else {
            opId = generateName(oasPath, "function") + method.toUpperCase();
            logger.debug("Oas-doc does not have opearationId property for " + method.toUpperCase() + " - " + oasPath + " -> operationId name autogenerated: " + opId);
          }

          if (paths[oasPath][method]['x-router-controller'] != undefined) {
            controllerName = paths[oasPath][method]['x-router-controller'];
          } else if (paths[oasPath][method]['x-swagger-router-controller'] != undefined) {
            controllerName = paths[oasPath][method]['x-swagger-router-controller'];
          } else {
            controllerName = generateName(oasPath, "controller");
            logger.debug("Oas-doc does not have routing property for " + method.toUpperCase() + " - " + oasPath + " -> controller name autogenerated: " + controllerName);
          }
          controllerName = generateName(controllerName, undefined);

          logger.debug("Write: " + opId);

          if (!controller_files.includes(controllerName)) {
            controller_files.push(controllerName);
            controller_files.push(controllerName + "Service");
            var controllerVariable = generateName(controllerName, "variable"); //sanitize variable name for controller's require
            var header = "'use strict' \n\nvar " + controllerVariable + " = require('./" + controllerName + "Service');\n\n";
            fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + ".js", header);
            fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + "Service.js", "'use strict'\n\n");
          }
          var function_string = "module.exports." + opId + " = function " + opId + " (req, res, next) {\n" + controllerVariable + "." + opId + "(req.swagger.params, res, next);\n};\n\n";
          var function_string_service = "module.exports." + opId + " = function " + opId + " (req, res, next) {\nres.send({message: 'This is the mockup controller for " + opId + "' });\n};\n\n";
          fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + ".js", function_string);
          fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + "Service.js", function_string_service);
        }
      }

      /* beautify files */
      for (var i = 0; i < controller_files.length; i++) {
        logger.debug("Beautify file " + controller_files[i]);
        var data = fs.readFileSync(process.cwd() + '/controllers/' + controller_files[i] + ".js", 'utf8');
        fs.writeFileSync(process.cwd() + '/controllers/' + controller_files[i] + ".js", beautify(data, {
          indent_size: 2,
          space_in_empty_paren: true
        }));
      }

      /* create zip or dir */
      process.chdir('..');
      if (cmd.generateZip) { //option -z used: generate zip and delete folder
        zipdir('./' + projectName, {
          saveTo: projectName + '.zip'
        }, function(err, buffer) {  //eslint-disable-line
          if (err) {
            logger.error('Compressor error: ', err);
          } else {
            logger.debug('---< NodeJS project ZIP generated! >---');
          }
        });
        rimraf.sync(projectName);
      } else {
        logger.debug('---< NodeJS project folder generated! >---');
      }

    } catch (err) {
      logger.error(err);
    }
  }
}

function configure(options) {
    config.setConfigurations(options);
    if (options.loglevel != undefined) {
        logger = config.logger; //loglevel changes, then new logger is needed
    }
}

module.exports = {
    generateServer: generateServer, // eslint-disable-line
    configure: configure // eslint-disable-line
};
