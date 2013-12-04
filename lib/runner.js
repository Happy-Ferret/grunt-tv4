// Bulk validation core: composites with tv4, miniwrite, ministyle and loaders

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function nextTick(call) {
	//lame setImmediate
	setTimeout(call, 1);
}

function forAsync(items, iter, callback) {
	var keys = Object.keys(items);
	var step = function (err, callback) {
		nextTick(function () {
			if (err) {
				return callback(err);
			}
			if (keys.length === 0) {
				return callback();
			}
			var key = keys.pop();
			iter(items[key], key, function (err) {
				step(err, callback);
			});
		});
	};
	step(null, callback);
}

function copyProps(target, source, recursive) {
	if (source) {
		Object.keys(source).forEach(function (key) {
			if (recursive && typeof source[key] === 'object') {
				target[key] = copyProps((Array.isArray(source[key]) ? [] : {}), source[key], recursive);
				return;
			}
			target[key] = source[key];
		});
	}
	return target;
}

function sortLabel(a, b) {
	if (a.label < b.label) {
		return 1;
	}
	if (a.label > b.label) {
		return -1;
	}
	// a must be equal to b
	return 0;
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function isURL(uri) {
	return (/^https?:/.test(uri) || /^file:/.test(uri));
}

var headExp = /^(\w+):/;

function getURLProtocol(uri) {
	if (isURL(uri)) {
		headExp.lastIndex = 0;
		var res = headExp.exec(uri);
		if ((res && res.length >= 2)) {
			return res[1];
		}
	}
	return '<unknown uri protocol>';
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

function getOptions(merge) {
	var options = {
		root: null,
		schemas: {},
		add: [],
		formats: {},
		fresh: false,
		multi: false,
		timeout: 5000,
		checkRecursive: false,
		banUnknown: true,
		languages: {},
		language: null
	};
	return copyProps(options, merge);
}

function getRunner(tv4, loader, out, style) {

	function getContext(options) {
		var context = {};
		context.tv4 = tv4.freshApi();
		context.options = {};

		//import options
		if (options) {
			context.options = getOptions(options);
		}

		context.validate = function (objects, callback) {
			var job = {
				context: context,
				total: objects.length,
				objects: objects,
				success: true,
				error: null,
				passed: [],
				failed: []
			};

			if (job.objects.length === 0) {
				job.error = new Error('zero objects selected');
				finaliseTask(job.error, job, callback);
				return;
			}
			job.objects.sort(sortLabel);

			//start the flow
			loadSchemaList(job, job.context.tv4.getMissingUris(), function (err) {
				if (err) {
					return finaliseTask(err, job, callback);
				}
				forAsync(job.objects, function (object, index, callback) {
					validateObject(job, object, callback);

				}, function (err) {
					finaliseTask(err, job, callback);
				});
			});
		};
		return context;
	}

	var repAccent = style.accent('/');
	var repProto = style.accent('://');

	function tweakURI(str) {
		return str.split(/:\/\//).map(function (str) {
			return str.replace(/\//g, repAccent);
		}).join(repProto);
	}

	function finaliseTask(err, job, callback) {
		job.success = (job.success && !job.error && job.failed.length === 0);
		if (job.error) {
			out.writeln('');
			out.writeln(style.warning('warning: ') + job.error);
			out.writeln('');
			callback(null, job);
			return;
		}
		if (err) {
			out.writeln('');
			out.writeln(style.error('error: ') + err);
			out.writeln('');
			callback(err, job);
			return;
		}
		out.writeln('');
		callback(null, job);
	}

	//load and add batch of schema by uri, repeat until all missing are solved
	function loadSchemaList(job, uris, callback) {
		var sweep = function () {
			if (uris.length === 0) {
				return callback();
			}
			forAsync(uris, function (uri, i, callback) {
				out.writeln('> ' + style.accent('load') + ' + ' + tweakURI(uri));

				loader.load(uri, job.context.options, function (err, schema) {
					if (err) {
						return callback(err);
					}
					job.context.tv4.addSchema(uri, schema);
					uris = job.context.tv4.getMissingUris();
					callback();
				});
			}, function (err) {
				if (err) {
					job.error = err;
					return callback(null);
				}
				// sweep again
				sweep();
			});
		};
		sweep();
	}

	//supports automatic lazy loading
	function recursiveTest(job, object, callback) {
		var opts = job.context.options;
		if (job.context.options.multi) {
			object.result = job.context.tv4.validateMultiple(object.value, object.schema, opts.checkRecursive, opts.banUnknown);
		}
		else {
			object.result = job.context.tv4.validateResult(object.value, object.schema, opts.checkRecursive, opts.banUnknown);
		}

		//TODO verify reportOnMissing
		if (!object.result.valid) {
			job.failed.push(object);
			out.writeln('> ' + style.error('fail') + ' - ' + tweakURI(object.label));
			return callback();
		}
		if (object.result.missing.length === 0) {
			job.passed.push(object);
			out.writeln('> ' + style.success('pass') + ' | ' + tweakURI(object.label));
			return callback();
		}

		// auto load missing (if loading has an error  we'll bail way back)
		loadSchemaList(job, object.result.missing, function (err) {
			if (err) {
				return callback(err);
			}
			//check again
			recursiveTest(job, object, callback);
		});
	}

	function startLoading(job, object, callback) {
		//pre fetch (saves a validation round)
		loadSchemaList(job, job.context.tv4.getMissingUris(), function (err) {
			if (err) {
				return callback(err);
			}
			recursiveTest(job, object, callback);
		});
	}

	//validate single object
	function validateObject(job, object, callback) {
		if (typeof object.value === 'undefined') {
			var onLoad = function (err, obj) {
				if (err) {
					job.error = err;
					return callback(err);
				}
				object.value = obj;
				doValidateObject(job, object, callback);
			};
			var opts = {
				timeout: (job.context.options.timeout || 5000)
			};
			//TODO verify http:, file: and plain paths all load properly
			if (object.path) {
				loader.loadPath(object.path, opts, onLoad);
			}
			else if (object.url) {
				loader.load(object.url, opts, onLoad);
			}
			else {
				callback(new Error('object missing value, path or url'));
			}
		}
		else {
			doValidateObject(job, object, callback);
		}
	}

	function doValidateObject(job, object, callback) {
		if (!object.root) {
			//out.writeln(style.warn('no explicit root schema'));
			//out.writeln('');
			//TODO handle this better
			job.error = new Error('no explicit root schema');
			callback(job);
			return;
		}
		var t = typeof object.root;

		switch (t) {
			case 'object':
				if (!Array.isArray(object.root)) {
					object.schema = object.root;
					job.context.tv4.addSchema((object.schema.id || ''), object.schema);

					startLoading(job, object, callback);
				}
				return;
			case 'string':
				//known from previous sessions?
				var schema = job.context.tv4.getSchema(object.root);
				if (schema) {
					out.writeln('> ' + style.plain('have') + ' : ' + tweakURI(object.root));
					object.schema = schema;

					recursiveTest(job, object, callback);
					return;
				}
				out.writeln('> ' + style.accent('load') + ' > ' + tweakURI(object.root));

				loader.load(object.root, job.context.options, function (err, schema) {
					if (err) {
						job.error = err;
						return callback(job.error);
					}
					if (!schema) {
						job.error = new Error('no schema loaded from: ' + object.root);
						return callback(job.error);
					}
					if (isURL(object.root)) {
						object.schema = schema;
						job.context.tv4.addSchema(object.root, schema);
					}
					else {
						object.schema = schema;
						//TODO use object.root? as id? (no, not uri: file:// uris are catched above)
						job.context.tv4.addSchema((object.schema.id || ''), object.schema);
					}
					startLoading(job, object, callback);
				});
				return;
			default:
				callback(new Error('dont know how to load: ' + object.root));
				return;
		}
	}

	return {
		isURL: isURL,
		getURLProtocol: getURLProtocol,
		getOptions: getOptions,
		getContext: getContext
	};
}

module.exports = {
	getRunner: getRunner
};