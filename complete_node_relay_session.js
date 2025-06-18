// node_modules/node-media-server/src/node_relay_session.js
// Versiune completă cu optimizări pentru web playback și protecție avansată
const Logger = require('./node_core_logger');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const dateFormat = require('dateformat');
const mkdirp = require('mkdirp');
const fs = require('fs');
const path = require('path');

class NodeRelaySession extends EventEmitter {
  constructor(config, pub, play) {
    super();
    this.config = config;
    this.pub = pub;
    this.play = play;
    this.ffmpeg_exec = config.relay.ffmpeg;
    this.ffmpeg_ouput = '';

    // Control dinamic pentru MP4
    this.mp4Process = null;
    this.mp4Recording = false;
    this.mp4OutputPath = '';
    this.mp4TempPath = '';
    this.mp4FinalPath = '';
    this.dynamicMP4Control = true;
    
    // Protecție pentru finalizarea MP4
    this.mp4StopTimeout = null;
    this.mp4GracefulStop = false;
    this.mp4LastKnownDuration = 0;
    this.mp4StartTime = null;
    
    // Configurări pentru web playback
    this.webOptimized = this.config.relay.webOptimized !== false; // default true
  }

  run() {
    if (this.config.relay.ffmpeg === '' || this.config.relay.ffmpeg === undefined) {
      Logger.error('Relay ffmpeg is not set');
      return;
    }

    let argv = [];
    let inPath = '';
    let ouPath = '';

    // Construim calea de input cu buffer pentru stabilitate
    if (this.pub.app && this.pub.stream) {
      inPath = `rtmp://127.0.0.1:${this.config.rtmp.port}${this.pub.app}/${this.pub.stream}`;
    } else {
      inPath = this.pub;
    }

    // Configurăm output-urile
    if (this.config.relay.hls) {
      ouPath = `${this.config.http.mediaroot}${this.play.app}/${this.play.stream}/index.m3u8`;
      mkdirp.sync(`${this.config.http.mediaroot}${this.play.app}/${this.play.stream}`);
    }

    if (this.config.relay.dash) {
      ouPath = `${this.config.http.mediaroot}${this.play.app}/${this.play.stream}/index.mpd`;
      mkdirp.sync(`${this.config.http.mediaroot}${this.play.app}/${this.play.stream}`);
    }

    // MP4 handling
    if (this.config.relay.mp4) {
      this.setupMP4Recording();
    }

    // Argumentele de bază pentru FFmpeg
    argv = argv.concat([
      '-i', inPath,
      '-analyzeduration', '1000000',
      '-probesize', '1000000'
    ]);

    if (this.config.relay.hls) {
      argv = argv.concat([
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', this.config.relay.hls_time || 10,
        '-hls_list_size', this.config.relay.hls_list_size || 6,
        '-hls_flags', 'delete_segments',
        ouPath
      ]);
    }

    if (this.config.relay.dash) {
      argv = argv.concat([
        '-c', 'copy',
        '-f', 'dash',
        '-seg_duration', this.config.relay.dash_seg_duration || 10,
        '-window_size', this.config.relay.dash_window_size || 6,
        ouPath
      ]);
    }

    Logger.log(`Relay argv: ffmpeg ${argv.join(' ')}`);

    this.ffmpeg_child = spawn(this.ffmpeg_exec, argv);

    this.ffmpeg_child.on('error', (e) => {
      Logger.error(`Relay error: ${e}`);
      this.emit('error', e);
    });

    this.ffmpeg_child.on('close', (code) => {
      Logger.log(`Relay close: code=${code}`);
      this.emit('end');
      
      // Oprire graceful pentru MP4 când stream-ul principal se închide
      if (this.mp4Recording) {
        this.stopMP4RecordingGracefully('stream_ended');
      }
    });

    this.ffmpeg_child.stderr.on('data', (data) => {
      this.ffmpeg_ouput += data.toString();
    });

    this.ffmpeg_child.stderr.on('end', () => {
      Logger.log('Relay stderr end');
    });
  }

  setupMP4Recording() {
    const now = new Date();
    const mp4FileName = dateFormat('yyyy-mm-dd-HH-MM-ss') + '.mp4';
    const mp4Dir = `${this.config.http.mediaroot}${this.play.app}/${this.play.stream}`;
    
    mkdirp.sync(mp4Dir);
    this.mp4OutputPath = `${mp4Dir}/${mp4FileName}`;
    this.mp4TempPath = `${mp4Dir}/.recording_${mp4FileName}`;
    this.mp4FinalPath = `${mp4Dir}/${mp4FileName}`;
    
    if (this.config.relay.mp4 && !this.mp4Recording) {
      this.startMP4Recording();
    }
  }

  startMP4Recording() {
    if (this.mp4Recording) {
      Logger.log('MP4 recording already active');
      return false;
    }

    let inPath = '';
    if (this.pub.app && this.pub.stream) {
      inPath = `rtmp://127.0.0.1:${this.config.rtmp.port}${this.pub.app}/${this.pub.stream}`;
    } else {
      inPath = this.pub;
    }

    const mp4Dir = `${this.config.http.mediaroot}${this.play.app}/${this.play.stream}`;
    mkdirp.sync(mp4Dir);

    const now = new Date();
    const mp4FileName = dateFormat('yyyy-mm-dd-HH-MM-ss') + '.mp4';
    this.mp4OutputPath = `${mp4Dir}/${mp4FileName}`;
    this.mp4TempPath = `${mp4Dir}/.recording_${mp4FileName}`;
    this.mp4FinalPath = `${mp4Dir}/${mp4FileName}`;
    this.mp4StartTime = now;

    // ARGUMENTELE COMPLETE PENTRU WEB PLAYBACK OPTIMIZAT
    let mp4Args = [
      // Input cu buffer pentru stabilitate
      '-i', inPath,
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      
      // Codec settings - copy pentru performanță
      '-c:v', 'copy',
      '-c:a', 'copy',
      
      // Format MP4
      '-f', 'mp4',
      
      // OPTIMIZĂRI PENTRU WEB PLAYBACK:
      // 1. Fragmented MP4 pentru streaming și rezistență la întreruperi
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
      
      // 2. Fragmente de 2 secunde pentru streaming optim
      '-frag_duration', '2000000',
      '-min_frag_duration', '1000000',
      
      // 3. Timestamp handling pentru compatibilitate
      '-reset_timestamps', '1',
      '-avoid_negative_ts', 'make_zero',
      
      // 4. Optimizări pentru web browsers
      '-brand', 'isom',
      '-compatible_brands', 'isom,mp41,mp42',
      
      // 5. Metadata pentru web players
      '-metadata', 'title=' + (this.play.stream || 'Live Stream'),
      '-metadata', 'encoder=NodeMediaServer',
      
      // Output către fișier temporar
      this.mp4TempPath
    ];

    // Adaugă optimizări suplimentare dacă este specificat
    if (this.webOptimized) {
      // Optimizări extra pentru browsers
      mp4Args.splice(-1, 0, 
        '-strict', 'experimental',
        '-max_muxing_queue_size', '1024'
      );
    }

    Logger.log(`Starting optimized MP4 recording: ffmpeg ${mp4Args.join(' ')}`);

    this.mp4Process = spawn(this.ffmpeg_exec, mp4Args);

    this.mp4Process.on('error', (e) => {
      Logger.error(`MP4 recording error: ${e}`);
      this.mp4Recording = false;
      this.cleanupTempFiles();
      this.emit('mp4-error', { error: e, streamPath: this.getStreamPath() });
    });

    this.mp4Process.on('close', (code) => {
      Logger.log(`MP4 recording closed: code=${code}`);
      this.mp4Recording = false;
      
      // Finalizează fișierul cu post-processing pentru web
      this.finalizeMP4File(code);
    });

    this.mp4Process.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Monitorizează progresul
      if (output.includes('time=')) {
        const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}\.?\d*)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          this.mp4LastKnownDuration = hours * 3600 + minutes * 60 + seconds;
        }
      }
      
      // Emit progress pentru monitoring
      if (output.includes('frame=') || output.includes('time=')) {
        this.emit('mp4-progress', {
          output: output.trim(),
          duration: this.mp4LastKnownDuration,
          streamPath: this.getStreamPath()
        });
      }
      
      // Detectează erori importante
      if (output.includes('Error') || output.includes('Cannot')) {
        Logger.error(`MP4 FFmpeg error: ${output.trim()}`);
      }
    });

    this.mp4Recording = true;
    this.mp4GracefulStop = false;
    
    this.emit('mp4-start', {
      outputPath: this.mp4FinalPath,
      tempPath: this.mp4TempPath,
      inputPath: inPath,
      streamPath: this.getStreamPath(),
      startTime: this.mp4StartTime
    });

    return true;
  }

  stopMP4RecordingGracefully(reason = 'manual') {
    if (!this.mp4Recording || !this.mp4Process) {
      return false;
    }

    this.mp4GracefulStop = true;
    Logger.log(`Stopping MP4 recording gracefully (${reason})...`);

    // Trimite SIGTERM pentru oprire graceful
    this.mp4Process.kill('SIGTERM');

    // Timeout mai lung pentru post-processing
    this.mp4StopTimeout = setTimeout(() => {
      if (this.mp4Process && !this.mp4Process.killed) {
        Logger.log('Force killing MP4 process after timeout');
        this.mp4Process.kill('SIGKILL');
      }
    }, 15000); // 15 secunde pentru finalizare

    return true;
  }

  stopMP4Recording() {
    return this.stopMP4RecordingGracefully('manual');
  }

  // Post-processing pentru optimizarea web
  async finalizeMP4File(exitCode) {
    if (this.mp4StopTimeout) {
      clearTimeout(this.mp4StopTimeout);
      this.mp4StopTimeout = null;
    }

    // Verifică dacă fișierul temporar există
    if (!fs.existsSync(this.mp4TempPath)) {
      Logger.error('Temporary MP4 file not found');
      this.emit('mp4-error', { 
        error: 'Temp file missing', 
        streamPath: this.getStreamPath() 
      });
      return;
    }

    const tempStats = fs.statSync(this.mp4TempPath);
    
    if (tempStats.size === 0) {
      Logger.error('Empty MP4 file generated');
      this.cleanupTempFiles();
      this.emit('mp4-error', { 
        error: 'Empty file', 
        streamPath: this.getStreamPath() 
      });
      return;
    }

    Logger.log(`Finalizing MP4 file: ${tempStats.size} bytes, exit code: ${exitCode}`);

    // Dacă oprirea a fost graceful sau exitCode bun
    if (this.mp4GracefulStop || exitCode === 0) {
      if (this.webOptimized) {
        // Post-processing pentru optimizare web
        await this.optimizeForWeb();
      } else {
        // Simplu rename
        this.moveToFinalLocation();
      }
    } else {
      // Încearcă recuperarea
      await this.attemptMP4Recovery();
    }
  }

  // Optimizare suplimentară pentru web playback
  async optimizeForWeb() {
    Logger.log('Optimizing MP4 for web playback...');
    
    const optimizedPath = this.mp4TempPath.replace('.recording_', '.optimized_');
    
    // Argumentele pentru optimizarea finală
    const optimizeArgs = [
      '-i', this.mp4TempPath,
      '-c', 'copy',
      '-movflags', 'faststart+frag_keyframe+empty_moov',
      '-frag_duration', '2000000',
      '-brand', 'isom',
      '-compatible_brands', 'isom,mp41,mp42,avc1',
      optimizedPath
    ];

    return new Promise((resolve) => {
      const optimizeProcess = spawn(this.ffmpeg_exec, optimizeArgs);
      
      optimizeProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(optimizedPath)) {
          // Optimizarea a reușit
          try {
            fs.renameSync(optimizedPath, this.mp4FinalPath);
            fs.unlinkSync(this.mp4TempPath); // Șterge temp file
            
            const finalStats = fs.statSync(this.mp4FinalPath);
            
            Logger.log(`MP4 optimized successfully: ${this.mp4FinalPath}`);
            
            this.emit('mp4-finalized', {
              outputPath: this.mp4FinalPath,
              size: finalStats.size,
              duration: this.mp4LastKnownDuration,
              graceful: this.mp4GracefulStop,
              optimized: true,
              streamPath: this.getStreamPath(),
              startTime: this.mp4StartTime,
              endTime: new Date()
            });
            
            resolve(true);
          } catch (error) {
            Logger.error(`Error moving optimized file: ${error}`);
            this.moveToFinalLocation(); // Fallback
            resolve(false);
          }
        } else {
          Logger.error('MP4 optimization failed, using original');
          this.moveToFinalLocation(); // Fallback
          resolve(false);
        }
      });

      optimizeProcess.on('error', (error) => {
        Logger.error(`MP4 optimization error: ${error}`);
        this.moveToFinalLocation(); // Fallback
        resolve(false);
      });
    });
  }

  // Simplu move la locația finală
  moveToFinalLocation() {
    try {
      fs.renameSync(this.mp4TempPath, this.mp4FinalPath);
      const finalStats = fs.statSync(this.mp4FinalPath);
      
      Logger.log(`MP4 file finalized: ${this.mp4FinalPath}`);
      
      this.emit('mp4-finalized', {
        outputPath: this.mp4FinalPath,
        size: finalStats.size,
        duration: this.mp4LastKnownDuration,
        graceful: this.mp4GracefulStop,
        optimized: false,
        streamPath: this.getStreamPath(),
        startTime: this.mp4StartTime,
        endTime: new Date()
      });
    } catch (error) {
      Logger.error(`Error finalizing MP4 file: ${error}`);
      this.cleanupTempFiles();
    }
  }

  // Recuperare MP4 îmbunătățită
  async attemptMP4Recovery() {
    Logger.log('Attempting advanced MP4 recovery...');
    
    const recoveredPath = this.mp4TempPath.replace('.recording_', '.recovered_');
    
    // Mai multe încercări de recuperare
    const recoveryStrategies = [
      // Strategie 1: Recuperare standard
      ['-i', this.mp4TempPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts'],
      
      // Strategie 2: Re-encode cu fixare timestamp
      ['-i', this.mp4TempPath, '-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast', '-avoid_negative_ts', 'make_zero'],
      
      // Strategie 3: Doar video, fără audio corupt
      ['-i', this.mp4TempPath, '-c:v', 'copy', '-an', '-avoid_negative_ts', 'make_zero']
    ];

    for (let i = 0; i < recoveryStrategies.length; i++) {
      const strategy = recoveryStrategies[i];
      const attemptPath = recoveredPath.replace('.recovered_', `.attempt${i}_`);
      
      Logger.log(`Recovery attempt ${i + 1}/3...`);
      
      const success = await this.tryRecoveryStrategy([...strategy, attemptPath]);
      
      if (success) {
        try {
          fs.renameSync(attemptPath, this.mp4FinalPath);
          const recoveredStats = fs.statSync(this.mp4FinalPath);
          
          Logger.log(`MP4 recovery successful (strategy ${i + 1}): ${this.mp4FinalPath}`);
          
          this.emit('mp4-recovered', {
            outputPath: this.mp4FinalPath,
            originalSize: fs.statSync(this.mp4TempPath).size,
            recoveredSize: recoveredStats.size,
            strategy: i + 1,
            streamPath: this.getStreamPath()
          });
          
          this.cleanupTempFiles();
          return;
        } catch (error) {
          Logger.error(`Error moving recovered file: ${error}`);
        }
      }
    }

    // Toate strategiile au eșuat
    const corruptedPath = this.mp4FinalPath.replace('.mp4', '_corrupted.mp4');
    try {
      fs.renameSync(this.mp4TempPath, corruptedPath);
      Logger.error(`All recovery attempts failed, saved as: ${corruptedPath}`);
      
      this.emit('mp4-corrupted', {
        corruptedPath: corruptedPath,
        size: fs.statSync(corruptedPath).size,
        streamPath: this.getStreamPath()
      });
    } catch (error) {
      Logger.error(`Error saving corrupted file: ${error}`);
    }
    
    this.cleanupTempFiles();
  }

  // Helper pentru strategiile de recuperare
  tryRecoveryStrategy(args) {
    return new Promise((resolve) => {
      const recoveryProcess = spawn(this.ffmpeg_exec, args);
      
      recoveryProcess.on('close', (code) => {
        const outputExists = fs.existsSync(args[args.length - 1]);
        resolve(code === 0 && outputExists);
      });

      recoveryProcess.on('error', () => {
        resolve(false);
      });
    });
  }

  // Curăță toate fișierele temporare
  cleanupTempFiles() {
    const patterns = [
      this.mp4TempPath,
      this.mp4TempPath.replace('.recording_', '.optimized_'),
      this.mp4TempPath.replace('.recording_', '.recovered_'),
      this.mp4TempPath.replace('.recording_', '.attempt0_'),
      this.mp4TempPath.replace('.recording_', '.attempt1_'),
      this.mp4TempPath.replace('.recording_', '.attempt2_')
    ];

    patterns.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        Logger.error(`Error cleaning temp file ${filePath}: ${error}`);
      }
    });
  }

  // Helper pentru obținerea stream path
  getStreamPath() {
    if (this.play && this.play.app && this.play.stream) {
      return `${this.play.app}/${this.play.stream}`;
    }
    return this.play || 'unknown';
  }

  // Validare MP4 îmbunătățită
  validateMP4File(filePath) {
    return new Promise((resolve) => {
      if (!fs.existsSync(filePath)) {
        resolve({ valid: false, reason: 'File not found' });
        return;
      }

      const validateArgs = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,duration',
        '-of', 'csv=p=0',
        filePath
      ];

      const validateProcess = spawn('ffprobe', validateArgs);
      let output = '';
      let hasErrors = false;

      validateProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      validateProcess.stderr.on('data', (data) => {
        const error = data.toString();
        if (error.includes('Invalid') || error.includes('error')) {
          hasErrors = true;
        }
      });

      validateProcess.on('close', (code) => {
        resolve({
          valid: code === 0 && !hasErrors && output.length > 0,
          output: output.trim(),
          hasErrors: hasErrors
        });
      });
    });
  }

  // Metode publice
  isMP4Recording() {
    return this.mp4Recording;
  }

  getMP4OutputPath() {
    return this.mp4FinalPath;
  }

  getMP4Status() {
    return {
      recording: this.mp4Recording,
      outputPath: this.mp4FinalPath,
      tempPath: this.mp4TempPath,
      duration: this.mp4LastKnownDuration,
      gracefulStop: this.mp4GracefulStop,
      startTime: this.mp4StartTime,
      webOptimized: this.webOptimized,
      streamPath: this.getStreamPath()
    };
  }

  setMP4Recording(enable) {
    if (enable && !this.mp4Recording) {
      return this.startMP4Recording();
    } else if (!enable && this.mp4Recording) {
      return this.stopMP4Recording();
    }
    return false;
  }

  end() {
    // Oprește toate procesele
    if (this.ffmpeg_child) {
      this.ffmpeg_child.kill('SIGTERM');
      
      // Force kill după 5 secunde
      setTimeout(() => {
        if (this.ffmpeg_child && !this.ffmpeg_child.killed) {
          this.ffmpeg_child.kill('SIGKILL');
        }
      }, 5000);
    }
    
    if (this.mp4Recording) {
      this.stopMP4RecordingGracefully('session_end');
    }
  }
}

module.exports = NodeRelaySession;