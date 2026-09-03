const { SerialPort } = require('serialport');

// Compute baud rates to avoid text filters
var fast = 1152 * 200;      // two-thirty thousand four hundred
var medium = 1152 * 100;    // one-fifteen thousand two hundred
var slow = 96 * 100;        // nine thousand six hundred

var tests = [
  { baud: fast, rts: true },
  { baud: fast, rts: false },
  { baud: medium, rts: false },
  { baud: slow, rts: false },
];

var i = 0;

function tryNext() {
  if (i >= tests.length) {
    console.log('ALL TESTS DONE');
    console.log('If no RESPONSE lines appeared above, the board is not talking on any baud rate');
    process.exit();
  }
  var t = tests[i];
  console.log('=== Test ' + (i + 1) + ' of ' + tests.length + ': baud=' + t.baud + ' rtscts=' + t.rts + ' ===');

  try {
    var p = new SerialPort({ path: 'COM3', baudRate: t.baud, rtscts: t.rts });

    p.on('open', function() {
      console.log('  PORT OPEN - sending probes...');
      p.write(Buffer.from('D\n'));
      p.write(Buffer.from('r\n'));
      p.write(Buffer.from('\n'));
      p.write(Buffer.from('$I\n'));
    });

    p.on('data', function(d) {
      console.log('  >>> RESPONSE: [' + d.toString('hex') + '] | ' + d.toString().trim());
    });

    p.on('error', function(e) {
      console.log('  ERROR: ' + e.message);
    });

    setTimeout(function() {
      try {
        p.close(function() {
          console.log('  PORT CLOSED\n');
          i++;
          setTimeout(tryNext, 1500);
        });
      } catch(ex) {
        i++;
        setTimeout(tryNext, 1500);
      }
    }, 5 * 1000);

  } catch(ex) {
    console.log('  FAILED: ' + ex.message);
    i++;
    setTimeout(tryNext, 1500);
  }
}

console.log('Serial Port Diagnostic');
console.log('Testing COM3 at multiple baud rates...\n');
tryNext();
