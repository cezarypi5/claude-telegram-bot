const os = require('os');
const nets = os.networkInterfaces();
Object.keys(nets).forEach(function(name) {
  nets[name].forEach(function(addr) {
    if (addr.family === 'IPv4' && !addr.internal) {
      console.log(name + ': ' + addr.address);
    }
  });
});
