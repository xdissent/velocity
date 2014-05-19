

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
