// @flow

const EventEmitter = require('events').EventEmitter;
const TYPES = require('./data-type').typeByName;
const RequestError = require('./errors').RequestError;

// TODO: Figure out how to type the `rows` parameter here.
type CompletionCallback = (error: ?Error, rowCount: ?number, rows: any) => void;

type Parameter = {
  // TODO: `type` must be a valid TDS value type
  type: any,
  name: string,
  value: mixed,
  output: boolean,
  length: ?number,
  precision: ?number,
  scale: ?number
};

type ParameterOptions = {
  output?: boolean,
  length?: number,
  precision?: number,
  scale?: number
}

module.exports = class Request extends EventEmitter {
  sqlTextOrProcedure: ?string;
  parameters: Parameter[];
  parametersByName: { [string]: Parameter };
  originalParameters: Parameter[];
  preparing: boolean;
  canceled: boolean;
  paused: boolean;
  userCallback: CompletionCallback;
  handle: ?any; // TODO: Figure out the type here.
  error: ?Error;
  connection: ?any; // TODO: This should be `Connection`, not `any`.

  callback: (?Error) => void;

  constructor(sqlTextOrProcedure: ?string, callback: CompletionCallback) {
    super();

    this.sqlTextOrProcedure = sqlTextOrProcedure;
    this.parameters = [];
    this.parametersByName = {};
    this.originalParameters = [];
    this.preparing = false;
    this.handle = undefined;
    this.canceled = false;
    this.paused = false;
    this.error = undefined;
    this.connection = undefined;
    this.userCallback = callback;
    this.callback = function(err: ?Error) {
      if (this.preparing) {
        this.preparing = false;
        if (err) {
          this.emit('error', err);
        } else {
          this.emit('prepared');
        }
      } else {
        this.userCallback.apply(this, arguments);
        this.emit('requestCompleted');
      }
    };
  }

  // TODO: `type` must be a valid TDS value type
  addParameter(name: string, type: any, value: mixed, options: ?ParameterOptions) {
    if (options == null) {
      options = {};
    }

    const parameter: Parameter = {
      type: type,
      name: name,
      value: value,
      output: options.output || (options.output = false),
      length: options.length,
      precision: options.precision,
      scale: options.scale
    };
    this.parameters.push(parameter);
    this.parametersByName[name] = parameter;
  }

  // TODO: `type` must be a valid TDS value type
  addOutputParameter(name: string, type: any, value: mixed, options: ?ParameterOptions) {
    if (options == null) {
      options = {};
    }
    options.output = true;
    this.addParameter(name, type, value, options);
  }

  makeParamsParameter(parameters: Parameter[]) {
    let paramsParameter = '';
    for (let i = 0, len = parameters.length; i < len; i++) {
      const parameter = parameters[i];
      if (paramsParameter.length > 0) {
        paramsParameter += ', ';
      }
      paramsParameter += '@' + parameter.name + ' ';
      paramsParameter += parameter.type.declaration(parameter);
      if (parameter.output) {
        paramsParameter += ' OUTPUT';
      }
    }
    return paramsParameter;
  }

  transformIntoExecuteSqlRpc() {
    if (this.validateParameters()) {
      return;
    }

    this.originalParameters = this.parameters;
    this.parameters = [];
    this.addParameter('statement', TYPES.NVarChar, this.sqlTextOrProcedure);
    if (this.originalParameters.length) {
      this.addParameter('params', TYPES.NVarChar, this.makeParamsParameter(this.originalParameters));
    }

    for (let i = 0, len = this.originalParameters.length; i < len; i++) {
      const parameter = this.originalParameters[i];
      this.parameters.push(parameter);
    }
    this.sqlTextOrProcedure = 'sp_executesql';
  }

  transformIntoPrepareRpc() {
    this.originalParameters = this.parameters;
    this.parameters = [];
    this.addOutputParameter('handle', TYPES.Int);
    this.addParameter('params', TYPES.NVarChar, this.makeParamsParameter(this.originalParameters));
    this.addParameter('stmt', TYPES.NVarChar, this.sqlTextOrProcedure);
    this.sqlTextOrProcedure = 'sp_prepare';
    this.preparing = true;
    this.on('returnValue', (name, value) => {
      if (name === 'handle') {
        this.handle = value;
      } else {
        this.error = RequestError(`Tedious > Unexpected output parameter ${name} from sp_prepare`);
      }
    });
  }

  transformIntoUnprepareRpc() {
    this.parameters = [];
    this.addParameter('handle', TYPES.Int, this.handle);
    this.sqlTextOrProcedure = 'sp_unprepare';
  }

  transformIntoExecuteRpc(parameters: { [string]: mixed }) {
    this.parameters = [];
    this.addParameter('handle', TYPES.Int, this.handle);

    for (let i = 0, len = this.originalParameters.length; i < len; i++) {
      const parameter = this.originalParameters[i];
      parameter.value = parameters[parameter.name];
      this.parameters.push(parameter);
    }

    if (this.validateParameters()) {
      return;
    }

    this.sqlTextOrProcedure = 'sp_execute';
  }

  validateParameters() {
    for (let i = 0, len = this.parameters.length; i < len; i++) {
      const parameter = this.parameters[i];
      const value = parameter.type.validate(parameter.value);
      if (value instanceof TypeError) {
        return this.error = new RequestError('Validation failed for parameter \'' + parameter.name + '\'. ' + value.message, 'EPARAM');
      }
      parameter.value = value;
    }
    return null;
  }

  // Temporarily suspends the flow of data from the database.
  // No more 'row' events will be emitted until resume() is called.
  pause() {
    if (this.paused) {
      return;
    }
    this.paused = true;
    if (this.connection) {
      this.connection.pauseRequest(this);
    }
  }

  // Resumes the flow of data from the database.
  resume() {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    if (this.connection) {
      this.connection.resumeRequest(this);
    }
  }
};
