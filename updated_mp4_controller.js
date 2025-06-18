// mp4-controller-v2.7.js
// Controller complet pentru managementul dinamic al MP4 în Node Media Server v2.7.x

const fs = require('fs');
const path = require('path');
const Logger = require('./node_modules/node-media-server/src/node_core_logger');

class MP4Controller {
  constructor() {
    // Inițializare statistici
    this.recordingStats = new Map();
    this.sessionHistory = new Map();
  }

  // Pornește înregistrarea MP4 pentru un stream specific
  static startRecordingForStream(streamPath) {
    // Normalizează stream path
    const normalizedPath = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
    
    if (!global.activeRelaySessions) {
      throw new Error('No active relay sessions found. Ensure streams are active before starting recording.');
    }

    // Găsește sesiunea folosind mai multe strategii
    let session = global.activeRelaySessions.get(normalizedPath);
    
    if (!session) {
      // Încercări alternative de găsire a sesiunii
      const alternativePaths = [
        streamPath,
        streamPath.replace('/live/', ''),
        `/live/${streamPath.replace('/live/', '')}`,
        normalizedPath,
        streamPath.replace(/^\/+/, '/'), // Normalizare slashes
        streamPath.replace(/\/+$/, '') // Elimină trailing slashes
      ];
      
      for (const altPath of alternativePaths) {
        session = global.activeRelaySessions.get(altPath);
        if (session) {
          Logger.log(`Found session using alternative path: ${altPath}`);
          break;
        }
      }
      
      if (!session) {
        const availablePaths = Array.from(global.activeRelaySessions.keys());
        throw new Error(`No active session found for stream: ${streamPath}. Available streams: ${availablePaths.join(', ')}`);
      }
    }

    // Verifică dacă înregistrarea este deja activă
    if (session.isMP4Recording && session.isMP4Recording()) {
      throw new Error(`MP4 recording already active for stream: ${streamPath}`);
    }

    // Verifică dacă sesiunea suportă controlul MP4
    if (!session.startMP4Recording) {
      throw new Error(`Session does not support dynamic MP4 control. Update NodeRelaySession.`);
    }

    // Pornește înregistrarea
    const result = session.startMP4Recording();
    if (!result) {
      throw new Error(`Failed to start MP4 recording for stream: ${streamPath}`);
    }

    // Înregistrează în statistici
    const stats = {
      streamPath: streamPath,
      normalizedPath: normalizedPath,
      startTime: new Date(),
      outputPath: session.getMP4OutputPath ? session.getMP4OutputPath() : null,
      status: 'recording',
      sessionFound: true
    };
    
    if (!this.recordingStats) {
      this.recordingStats = new Map();
    }
    this.recordingStats.set(streamPath, stats);

    Logger.log(`MP4 recording started successfully for stream: ${streamPath}`);

    return {
      success: true,
      streamPath: streamPath,
      normalizedPath: normalizedPath,
      outputPath: stats.outputPath,
      startTime: stats.startTime,
      message: `MP4 recording started for stream: ${streamPath}`
    };
  }

  // Oprește înregistrarea MP4 pentru un stream specific
  static stopRecordingForStream(streamPath) {
    const normalizedPath = streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
    
    if (!global.activeRelaySessions) {
      throw new Error('No active relay sessions found');
    }

    // Găsește sesiunea
    let session = global.activeRelaySessions.get(normalizedPath) || 
                   global.activeRelaySessions.get(streamPath);
    
    if (!session) {
      // Încercări alternative
      const alternativePaths = [
        streamPath,
        streamPath.replace('/live/', ''),
        `/live/${streamPath.replace('/live/', '')}`,
        normalizedPath
      ];
      
      for (const altPath of alternativePaths) {
        session = global.activeRelaySessions.get(altPath);
        if (session) break;
      }
      
      if (!session) {
        throw new Error(`No active session found for stream: ${streamPath}`);
      }
    }

    // Verifică dacă înregistrarea este activă
    if (!session.isMP4Recording || !session.isMP4Recording()) {
      throw new Error(`No active MP4 recording found for stream: ${streamPath}`);
    }

    // Verifică dacă sesiunea suportă controlul MP4
    if (!session.stopMP4Recording) {
      throw new Error(`Session does not support dynamic MP4 control`);
    }

    // Obține path-ul de output înainte de oprire
    const outputPath = session.getMP4OutputPath ? session.getMP4OutputPath() : null;
    
    // Oprește înregistrarea
    const result = session.stopMP4Recording();
    
    if (!result) {
      throw new Error(`Failed to stop MP4 recording for stream: ${streamPath}`);
    }

    // Actualizează statistici
    if (this.recordingStats && this.recordingStats.has(streamPath)) {
      const stats = this.recordingStats.get(streamPath);
      stats.endTime = new Date();
      stats.status = 'stopped';
      stats.duration = stats.endTime - stats.startTime;
      stats.outputPath = outputPath;
    }

    Logger.log(`MP4 recording stopped successfully for stream: ${streamPath}`);

    return {
      success: true,
      streamPath: streamPath,
      outputPath: outputPath,
      endTime: new Date(),
      message: `MP4 recording stopped for stream: ${streamPath}`
    };
  }

  // Obține statusul înregistrării pentru toate stream-urile
  static getRecordingStatus() {
    const activeRecordings = [];
    const allSessions = [];
    const sessionDetails = [];

    if (global.activeRelaySessions) {
      for (const [streamPath, session] of global.activeRelaySessions.entries()) {
        const isRecording = session.isMP4Recording ? session.isMP4Recording() : false;
        const outputPath = (isRecording && session.getMP4OutputPath) ? session.getMP4OutputPath() : null;
        const status = session.getMP4Status ? session.getMP4Status() : null;
        
        const sessionInfo = {
          streamPath: streamPath,
          isRecording: isRecording,
          outputPath: outputPath,
          status: status,
          startTime: this.recordingStats && this.recordingStats.has(streamPath) ? 
                     this.recordingStats.get(streamPath).startTime : null,
          hasMP4Control: !!(session.startMP4Recording && session.stopMP4Recording)
        };
        
        allSessions.push(sessionInfo);
        sessionDetails.push({
          streamPath: streamPath,
          methods: {
            isMP4Recording: !!session.isMP4Recording,
            startMP4Recording: !!session.startMP4Recording,
            stopMP4Recording: !!session.stopMP4Recording,
            getMP4OutputPath: !!session.getMP4OutputPath,
            getMP4Status: !!session.getMP4Status
          }
        });
        
        if (sessionInfo.isRecording) {
          activeRecordings.push(sessionInfo);
        }
      }
    }

    return {
      activeRecordings: activeRecordings,
      allSessions: allSessions,
      sessionDetails: sessionDetails,
      totalActiveSessions: allSessions.length,
      totalActiveRecordings: activeRecordings.length,
      globalSessionsExists: !!global.activeRelaySessions,
      globalSessionsCount: global.activeRelaySessions ? global.activeRelaySessions.size : 0,
      timestamp: new Date().toISOString()
    };
  }

  // Pornește înregistrarea pentru toate stream-urile active
  static startRecordingForAllStreams() {
    if (!global.activeRelaySessions) {
      return { 
        success: true, 
        started: [], 
        errors: [], 
        message: 'No active sessions found' 
      };
    }

    const started = [];
    const errors = [];
    const skipped = [];

    for (const [streamPath, session] of global.activeRelaySessions.entries()) {
      try {
        // Verifică dacă sesiunea suportă controlul MP4
        if (!session.startMP4Recording) {
          skipped.push({
            streamPath: streamPath,
            reason: 'Session does not support MP4 control'
          });
          continue;
        }

        // Verifică dacă nu înregistrează deja
        if (session.isMP4Recording && session.isMP4Recording()) {
          skipped.push({
            streamPath: streamPath,
            reason: 'Already recording'
          });
          continue;
        }

        const result = session.startMP4Recording();
        if (result) {
          const outputPath = session.getMP4OutputPath ? session.getMP4OutputPath() : null;
          started.push({
            streamPath: streamPath,
            outputPath: outputPath,
            startTime: new Date()
          });

          // Actualizează statistici
          if (!this.recordingStats) {
            this.recordingStats = new Map();
          }
          this.recordingStats.set(streamPath, {
            streamPath: streamPath,
            startTime: new Date(),
            outputPath: outputPath,
            status: 'recording'
          });
        } else {
          errors.push({
            streamPath: streamPath,
            error: 'Failed to start recording (returned false)'
          });
        }
      } catch (error) {
        errors.push({
          streamPath: streamPath,
          error: error.message
        });
      }
    }

    Logger.log(`Bulk MP4 start: ${started.length} started, ${errors.length} errors, ${skipped.length} skipped`);

    return {
      success: true,
      started: started,
      errors: errors,
      skipped: skipped,
      message: `Started recording for ${started.length} streams, ${errors.length} errors, ${skipped.length} skipped`
    };
  }

  // Oprește înregistrarea pentru toate stream-urile active
  static stopRecordingForAllStreams() {
    if (!global.activeRelaySessions) {
      return { 
        success: true, 
        stopped: [], 
        errors: [], 
        message: 'No active sessions found' 
      };
    }

    const stopped = [];
    const errors = [];
    const skipped = [];

    for (const [streamPath, session] of global.activeRelaySessions.entries()) {
      try {
        // Verifică dacă sesiunea suportă controlul MP4
        if (!session.stopMP4Recording) {
          skipped.push({
            streamPath: streamPath,
            reason: 'Session does not support MP4 control'
          });
          continue;
        }

        // Verifică dacă înregistrează
        if (!session.isMP4Recording || !session.isMP4Recording()) {
          skipped.push({
            streamPath: streamPath,
            reason: 'Not recording'
          });
          continue;
        }

        const outputPath = session.getMP4OutputPath ? session.getMP4OutputPath() : null;
        const result = session.stopMP4Recording();
        
        if (result) {
          stopped.push({
            streamPath: streamPath,
            outputPath: outputPath,
            endTime: new Date()
          });

          // Actualizează statistici
          if (this.recordingStats && this.recordingStats.has(streamPath)) {
            const stats = this.recordingStats.get(streamPath);
            stats.endTime = new Date();
            stats.status = 'stopped';
            stats.duration = stats.endTime - stats.startTime;
          }
        } else {
          errors.push({
            streamPath: streamPath,
            error: 'Failed to stop recording (returned false)'
          });
        }
      } catch (error) {
        errors.push({
          streamPath: streamPath,
          error: error.message
        });
      }
    }

    Logger.log(`Bulk MP4 stop: ${stopped.length} stopped, ${errors.length} errors, ${skipped.length} skipped`);

    return {
      success: true,
      stopped: stopped,
      errors: errors,
      skipped: skipped,
      message: `Stopped recording for ${stopped.length} streams, ${errors.length} errors, ${skipped.length} skipped`
    };
  }

  // Obține lista stream-urilor active
  static getActiveStreams() {
    if (!global.activeRelaySessions) {
      return [];
    }

    return Array.from(global.activeRelaySessions.keys()).map(streamPath => ({
      streamPath: streamPath,
      hasMP4Control: !!(global.activeRelaySessions.get(streamPath).startMP4Recording),
      isRecording: global.activeRelaySessions.get(streamPath).isMP4Recording ? 
                   global.activeRelaySessions.get(streamPath).isMP4Recording() : false
    }));
  }

  // Debug: Afișează toate sesiunile și metodele disponibile
  static debugSessions() {
    if (!global.activeRelaySessions) {
      return { error: 'No global.activeRelaySessions found' };
    }

    const sessions = {};
    for (const [streamPath, session] of global.activeRelaySessions.entries()) {
      sessions[streamPath] = {
        methods: Object.getOwnPropertyNames(session).filter(prop => typeof session[prop] === 'function'),
        properties: Object.getOwnPropertyNames(session).filter(prop => typeof session[prop] !== 'function'),
        prototype: Object.getOwnPropertyNames(Object.getPrototypeOf(session)).filter(prop => typeof session[prop] === 'function')
      };
    }

    return {
      totalSessions: global.activeRelaySessions.size,
      sessions: sessions
    };
  }
}

module.exports = MP4Controller;