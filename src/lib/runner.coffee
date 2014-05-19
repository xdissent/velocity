

class Velocity.Runner

  constructor: ->
    @_running = false
    @_callbacks = []

  run: (callback, args...) ->
    callback = Meteor.bindEnvironment callback ? ->
    return @_callbacks.push callback if @_running
    @_running = true
    @_run (err, result) =>
      callback err, result
      @_running = false
      @_runAgain() if @_callbacks.length > 0
    , args...

  _runAgain: ->
    [callbacks, @_callbacks] = [@_callbacks, []]
    @run (err, result) -> callback err, result for callback in callbacks

  _run: (callback) -> callback null



# Runs tests locally
class Velocity.Runner.Local extends Velocity.Runner

  constructor: (@_run) -> super



# Runs tests remotely via subscribe/publish
class Velocity.Runner.Remote extends Velocity.Runner

  constructor: (@mirror) -> super()

  _pipe: (src, dest) ->
    piped = false
    _pipe = ->
      piped = true
      src.pipe dest
    switch src._readableState.pipesCount
      when 0 then _pipe()
      when 1 then _pipe() unless src._readableState.pipes is dest
      else _pipe() unless dest in src._readableState.pipes
    piped

  _run: (callback, args...) ->
    @mirror.start (err) =>
      return callback err if err?
      id = Date.now()
      piped = @_pipe @mirror.child.stdout, process.stdout

      cleanup = =>
        clearTimeout timeout
        @mirror.unsubscribe subscription
        @mirror.child.stdout.unpipe process.stdout if piped

      timeout = setTimeout ->
        cleanup()
        callback new Error 'Remote run timed out'
      , 60000 # XXX Make this a setting and add to other runners

      subscription = (msg) ->
        switch msg?.cmd
          when 'resetReports', 'postResult', 'postLog'
            Velocity[msg.cmd] msg.args...
        return unless msg?.id is id
        cleanup()
        return callback new Error 'Remote error' if msg.result is 'error'
        callback null, msg.result

      @mirror.subscribe subscription
      @mirror.publish id: id, command: 'run', args: args



# Runs tests locally on a mirror, reporting back via subscribe/publish
class Velocity.Runner.Mirror extends Velocity.Runner.Local

  constructor: (_run, @mirror) ->
    super _run
    @mirror.subscribe (msg) =>
      return unless msg?.command is 'run'
      @run (err, result) =>
        result = 'error' if err?
        @mirror.publish id: msg.id, result: result
      , msg.args...
