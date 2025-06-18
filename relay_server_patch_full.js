// Patch pentru node_modules/node-media-server/src/node_relay_server.js
// Modificări pentru controlul dinamic MP4 în Node Media Server v2.7.x

const Logger = require('./node_core_logger');
const NodeRelaySession = require('./node_relay_session');
const EventEmitter = require('events');

class NodeRelayServer extends EventEmitter {
  constructor(config, nms) {
    super();
    this.config = config;
    this.nms = nms; // Referință la instanța principală NMS
    
    // ADĂUGARE NOUĂ: Registru global pentru sesiuni active
    if (!global.activeRelaySessions) {
      global.activeRelaySessions = new Map();
    }
    
    // ADĂUGARE NOUĂ: Registru pentru sesiuni per stream
    this.activeSessions = new Map();
  }

  // Funcția existentă pentru pornirea relay-ului - MODIFICATĂ
  startRelay(inPath, outPath, options = {}) {
    const sessionKey = this.generateSessionKey(inPath, outPath);
    
    // Verifică dacă sesiunea există deja
    if (this.activeSessions.has(sessionKey)) {
      Logger.log(`Relay session already exists for ${sessionKey}`);
      return this.activeSessions.get(sessionKey);
    }

    Logger.log(`Starting relay session: ${sessionKey}`);
    
    // Creează configurația pentru sesiune
    const sessionConfig = {
      ...this.config,
      // ADĂUGARE NOUĂ: Controlul dinamic MP4 pornit
      relay: {
        ...this.config.relay,
        mp4: options.mp4 || false, // Controlat dinamic
        webOptimized: options.webOptimized !== false // default true
      }
    };

    // Creează sesiunea relay
    const relaySession = new NodeRelaySession(sessionConfig, inPath, outPath);
    
    // ADĂUGARE NOUĂ: Înregistrează sesiunea în registrele globale
    this.activeSessions.set(sessionKey, relaySession);
    global.activeRelaySessions.set(this.normalizeStreamPath(sessionKey), relaySession);
    
    // ADĂUGARE NOUĂ: Event handlers pentru monitorizare și control
    this.setupSessionEventHandlers(relaySession, sessionKey);
    
    // Pornește sesiunea
    relaySession.run();
    
    return relaySession;
  }

  // FUNCȚIE NOUĂ: Setup event handlers pentru sesiune
  setupSessionEventHandlers(relaySession, sessionKey) {
    // Event handlers pentru MP4 recording
    relaySession.on('mp4-start', (info) => {
      Logger.log(`MP4 recording started for ${sessionKey}`);
      this.emit('mp4RecordingStart', {
        sessionKey: sessionKey,
        streamPath: info.streamPath,
        outputPath: info.outputPath,
        startTime: info.startTime
      });
      
      // Propagă către NMS principal
      if (this.nms && this.nms.emit) {
        this.nms.emit('mp4RecordingStart', {
          sessionKey: sessionKey,
          streamPath: info.streamPath,
          outputPath: info.outputPath
        });
      }
    });

    relaySession.on('mp4-finalized', (info) => {
      Logger.log(`MP4 recording finalized for ${sessionKey}`);
      this.emit('mp4RecordingStop', {
        sessionKey: sessionKey,
        streamPath: info.streamPath,
        outputPath: info.outputPath,
        size: info.size,
        duration: info.duration,
        optimized: info.optimized
      });
      
      if (this.nms && this.nms.emit) {
        this.nms.emit('mp4RecordingStop', {
          sessionKey: sessionKey,
          streamPath: info.streamPath,
          outputPath: info.outputPath
        });
      }
    });

    relaySession.on('mp4-error', (error) => {
      Logger.error(`MP4 recording error for ${sessionKey}:`, error);
      this.emit('mp4RecordingError', {
        sessionKey: sessionKey,
        error: error
      });
      
      if (this.nms && this.nms.emit) {
        this.nms.emit('mp4RecordingError', {
          sessionKey: sessionKey,
          error: error
        });
      }
    });

    // Cleanup când sesiunea se termină
    relaySession.on('end', () => {
      Logger.log(`Relay session ended: ${sessionKey}`);
      this.cleanupSession(sessionKey);
    });

    relaySession.on('error', (error) => {
      Logger.error(`Relay session error for ${sessionKey}:`, error);
      this.cleanupSession(sessionKey);
    });
  }

  // FUNCȚIE NOUĂ: Cleanup sesiune
  cleanupSession(sessionKey) {
    if (this.activeSessions.has(sessionKey)) {
      this.activeSessions.delete(sessionKey);
      Logger.log(`Cleaned up local session: ${sessionKey}`);
    }
    
    const normalizedKey = this.normalizeStreamPath(sessionKey);
    if (global.activeRelaySessions && global.activeRelaySessions.has(normalizedKey)) {
      global.activeRelaySessions.delete(normalizedKey);
      Logger.log(`Cleaned up global session: ${normalizedKey}`);
    }
  }

  // FUNCȚIE NOUĂ: Generare cheie sesiune
  generateSessionKey(inPath, outPath) {
    // Extrage stream path din inPath sau outPath
    if (typeof inPath === 'object' && inPath.app && inPath.stream) {
      return `/${inPath.app}/${inPath.stream}`;
    }
    
    // Încearcă să extragă din string
    const match = inPath.match(/\/([^\/]+)\/([^\/\?]+)/);
    if (match) {
      return `/${match[1]}/${match[2]}`;
    }
    
    // Fallback
    return inPath.toString();
  }

  // FUNCȚIE NOUĂ: Normalizare stream path
  normalizeStreamPath(streamPath) {
    if (!streamPath.startsWith('/')) {
      return `/${streamPath}`;
    }
    return streamPath;
  }

  // FUNCȚIE NOUĂ: Obține sesiunea pentru un stream
  getSessionForStream(streamPath) {
    const normalizedPath = this.normalizeStreamPath(streamPath);
    
    // Încearcă să găsească în registrul global
    if (global.activeRelaySessions && global.activeRelaySessions.has(normalizedPath)) {
      return global.activeRelaySessions.get(normalizedPath);
    }
    
    // Încearcă cu variante alternative
    const alternatives = [
      streamPath,
      streamPath.replace('/live/', ''),
      `/live/${streamPath.replace('/live/', '')}`,
      normalizedPath
    ];
    
    for (const alt of alternatives) {
      if (global.activeRelaySessions && global.activeRelaySessions.has(alt)) {
        return global.activeRelaySessions.get(alt);
      }
    }
    
    return null;
  }

  // FUNCȚIE NOUĂ: Obține toate sesiunile active
  getActiveSessions() {
    return Array.from(this.activeSessions.entries()).map(([key, session]) => ({
      sessionKey: key,
      streamPath: this.normalizeStreamPath(key),
      isMP4Recording: session.isMP4Recording ? session.isMP4Recording() : false,
      mp4OutputPath: session.getMP4OutputPath ? session.getMP4OutputPath() : null,
      status: session.getMP4Status ? session.getMP4Status() : null
    }));
  }

  // FUNCȚIE NOUĂ: Start MP4 pentru stream specific
  startMP4ForStream(streamPath) {
    const session = this.getSessionForStream(streamPath);
    if (!session) {
      throw new Error(`No active session found for stream: ${streamPath}`);
    }
    
    if (session.isMP4Recording && session.isMP4Recording()) {
      throw new Error(`MP4 recording already active for stream: ${streamPath}`);
    }
    
    if (!session.startMP4Recording) {
      throw new Error(`Session does not support MP4 recording control`);
    }
    
    const result = session.startMP4Recording();
    if (!result) {
      throw new Error(`Failed to start MP4 recording for stream: ${streamPath}`);
    }
    
    return {
      success: true,
      streamPath: streamPath,
      outputPath: session.getMP4OutputPath ? session.getMP4OutputPath() : null
    };
  }

  // FUNCȚIE NOUĂ: Stop MP4 pentru stream specific
  stopMP4ForStream(streamPath) {
    const session = this.getSessionForStream(streamPath);
    if (!session) {
      throw new Error(`No active session found for stream: ${streamPath}`);
    }
    
    if (!session.isMP4Recording || !session.isMP4Recording()) {
      throw new Error(`No active MP4 recording found for stream: ${streamPath}`);
    }
    
    if (!session.stopMP4Recording) {
      throw new Error(`Session does not support MP4 recording control`);
    }
    
    const outputPath = session.getMP4OutputPath ? session.getMP4OutputPath() : null;
    const result = session.stopMP4Recording();
    
    if (!result) {
      throw new Error(`Failed to stop MP4 recording for stream: ${streamPath}`);
    }
    
    return {
      success: true,
      streamPath: streamPath,
      outputPath: outputPath
    };
  }

  // Funcția existentă pentru oprirea relay-ului - MODIFICATĂ
  stopRelay(sessionKey) {
    if (this.activeSessions.has(sessionKey)) {
      const session = this.activeSessions.get(sessionKey);
      
      // Oprește MP4 recording dacă este activ
      if (session.isMP4Recording && session.isMP4Recording()) {
        Logger.log(`Stopping MP4 recording for session: ${sessionKey}`);
        session.stopMP4Recording();
      }
      
      // Oprește sesiunea
      session.end();
      
      // Cleanup
      this.cleanupSession(sessionKey);
      
      Logger.log(`Stopped relay session: ${sessionKey}`);
      return true;
    }
    
    Logger.log(`Relay session not found: ${sessionKey}`);
    return false;
  }

  // FUNCȚIE NOUĂ: Oprește toate sesiunile
  stopAllSessions() {
    const stoppedSessions = [];
    
    for (const [sessionKey, session] of this.activeSessions.entries()) {
      try {
        // Oprește MP4 recording dacă este activ
        if (session.isMP4Recording && session.isMP4Recording()) {
          session.stopMP4Recording();
        }
        
        session.end();
        stoppedSessions.push(sessionKey);
      } catch (error) {
        Logger.error(`Error stopping session ${sessionKey}:`, error);
      }
    }
    
    // Cleanup complet
    this.activeSessions.clear();
    if (global.activeRelaySessions) {
      global.activeRelaySessions.clear();
    }
    
    Logger.log(`Stopped ${stoppedSessions.length} relay sessions`);
    return stoppedSessions;
  }
}

module.exports = NodeRelayServer;