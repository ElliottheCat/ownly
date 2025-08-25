import { EventEmitter } from 'events';
import * as Y from 'yjs';
import { nanoid } from 'nanoid'

import { GlobalBus } from '@/services/event-bus';
import type { SvsProvider } from '@/services/svs-provider';
import type { WorkspaceAPI } from './ndn';
import type TypedEmitter from 'typed-emitter';

/**
 * AgentCard describes the metadata exposed by an A2A agent.
 * The shape of this interface matches the common fileds in the Agent-toAgent specificaiton.
 * Additional fields may be added when needed.
 */

export interface AgentCard {
  /** Human readable name for the agent */
  name: string;
  /** Short description of the agent */
  description: string;
  /** Base URL where the agent is hosted */
  url: string;
  /** Provider information for teh agent */
  provider?: {
    /** Owning organisation of the agent */
    organization?: string;
    /** Website for the organisaiton */
    url?: string;
  };
  /** A2A protocol version implemented by the agent */
  version?: string;
  /** Optional extra fields */
  [key: string]: unknown;

}

/**
 * A chat channel bound ot a specific agent. Each agent channel keeps track of the agent card so calls can be routed correctly.
 */
export interface AgentChannel {
  /** Unique identifier for the channel */
  uuid: string;
  /** Display name for the channel */
  name: string;
  /** The resolved agent card for communicaiton */
  agent: AgentCard;
}

/** Individual message exchanged in an agent channel. The rule field distinguishes between. messages sent by the suer and thos sent by the agent. */
export interface AgentMessage{
  /** Unique identifier of the message */
  uuid: string;
  /** Identifier of the sender (user name or agent name)*/
  user: string;
  /** timestamp when the message was sent (epoch milliseconds) */
  ts: number;
  /** Content of the message */
  message: string;
  /** The role of the sender ('user' for human, 'agent' for replies) */
  role: 'user' | 'agent';
}


/** WorkspaceAgent encapsulates discovery of agents, creation of dedicated channels and chat with those agents. It persists its state in a Yjs document backed by an SVS provider so taht channel lists and chat history are replicated to peers via NDN */
export class WorkspaceAgent{
  /** List of all agents channels*/
  private readonly channels: Y.Array<AgentChannel>;
  /** Map of chat messages for each channel */
  private readonly messages: Y.Map<Y.Array<AgentMessage>>;
  /** Event emitter to notify listenrs about new messages or channel changes.
   * - 'chat' fires when a new message is added to any channel
   * - 'channelAdded' fires when a new agent channel is created.
   */
  public readonly events = new EventEmitter() as TypedEmitter<{
    chat: (channel: string, message: AgentMessage)=> void;
    channelAdded: (channel: AgentChannel) => void;
  }>;

  /** private constructor. instances should be created via the static {@link create} method which handles loading the underlying Yjs documents. */

  private constructor(
    private readonly api: WorkspaceAPI,
    private readonly doc: Y.Doc,
  ) {
    this.channels = doc.getArray<AgentChannel>('_agent_chan_');
    this.messages = doc.getMap<Y.Array<AgentMessage>>('_agent_msg_');

    // Observe channel list changes and forward them onto the global bus.
    const emitChannels = () => {
      // Emit agent channels to a separate event
      GlobalBus.emit('agent-channels', this.channels.toArray());
    };
    this.channels.observe(emitChannels);
    //broadcast the current state of channels when the WorkspaceAgent is first created, ensuring the UI starts with the correct channel list.
    emitChannels();

    //Observe deep changes to the message map and notify local listeners.
    this.messages.observeDeep((events)=> {
      if (this.events.listenerCount(('chat'))=== 0) return;
      for (const ev of events){
        if (ev.path.length > 0) {
          const channelUuid = String(ev.path[0]);
          
          // Find the channel name by UUID
          const channel = this.channels.toArray().find(c => c.uuid === channelUuid);
          if (!channel) {
            console.warn('Could not find channel for UUID:', channelUuid);
            continue;
          }

          // Use Set.forEach instead of for...of
          ev.changes.added.forEach(delta => {
            try {
              const content = delta.content.getContent();
              const messages = Array.isArray(content) ? content : [content];

              messages.forEach(msg => {
                if (msg) {
                  this.events.emit('chat', channel.name, msg as AgentMessage);
                }
              });
            } catch (error) {
              console.warn('Error processing message delta:', error);
            }
          });
        }
      }
    });
  }
  /**
   * Create the agent service for a workspace. A Yjs doc name 'agent' will be loaded or vreated via the given provider.
   * @param api WorkspaceAPI instance associated with teh workspave
   * @param provider SVS provider used to persist and sync state
   */
  public static async create(api: WorkspaceAPI, provider: SvsProvider): Promise<WorkspaceAgent> {
      const doc = await provider.getDoc('agent');
      return new WorkspaceAgent(api,doc);
    }

  /**
   * Destroy the agent service and release its resources.
   */
  public async destroy() {
    this.doc.destroy();
  }

  /**
   * Get a snapshot of the current list of agent channels.
   */
  public async getChannels(): Promise<AgentChannel[]> {
      return this.channels.toArray();
    }

  /**
   * Discover an agent card form a base URL. The default lookup lath is './wellknown/agent.json' as A2A specification. On secuss, reteched Json will be returned as an {@link AgentCard}.
   * If the request failes an exception will be thorown.
   * @param baseUrl Base URL of the agent server (without trailing slash)
   * @returns Promise resolving to the discovered {@link AgentCard}
   */
  public async discoverAgent(baseUrl: string): Promise<AgentCard> {
    const trimmed = baseUrl.replace(/\/+$/,'');

    try {
      const res = await fetch(`${trimmed}/.well-known/agent.json`, {
        mode: 'cors',
        headers: {
          'Accept': 'application/json',
        }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // The fetched JSON may include unknown properties; we can cast to AgentCard
      const card = (await res.json()) as AgentCard;

      // Attach the base URL if missing
      if (!card.url) {
        card.url = trimmed;
      }

      return card;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        throw new Error(
          `CORS Error: Cannot connect to ${baseUrl}. ` +
          `The agent server needs to allow cross-origin requests from your domain. ` +
          `Please add CORS headers or use a CORS proxy.`
        );
      }
      throw new Error(`Failed to discover agent at ${baseUrl}: ${error}`);
    }
  }

  /**
   * Create a new agent channel and initialize its message history.
   * if a channel with same dispaly name already exists, throw an exception
   * An initial system message iwll be added to the history indicating the agent has been added.
   *
   * @param agent The agent card obtained via {@link discoverAgent}
   * @param name Optional custom channel name. degaults to agent.name
   * */

  public async addAgentChannel(agent: AgentCard, name?:string): Promise<AgentChannel>{
    const chanName = name?? agent.name;
    const existing = this.channels.toArray().find((ch)=>ch.name === chanName);
    if (existing) throw new Error ('CHannel already exists');
    const channel: AgentChannel ={
      uuid: nanoid(),
      name: chanName,
      agent: agent,
    };
    this.channels.push([channel]);
    this.messages.set(channel.uuid, new Y.Array<AgentMessage>());
    this.events.emit('channelAdded', channel);
    //Add a system message announcing the new channel
    const sysMsg: AgentMessage = {
      uuid: nanoid(),
      user: 'ownly-bot',
      ts: Date.now(),
      message: `#${chanName} agent channel was created by ${this.api.name}`,
      role: 'agent',
    };
    (await this.getMsgArray(channel.uuid)).push([sysMsg]);
    return channel;
  }

  /**
   * Retrieve the message array for a given channel UUID or throw if it does not exist.
   * */
  private async getMsgArray(channelUuid: string): Promise<Y.Array<AgentMessage>> {
    const arr = this.messages.get(channelUuid);
    if (!arr) throw new Error('Channel does not exist');
    return arr;
  }

  /** Get a snapshot of the message history for a channel */
  public async getMessages(channelName: string): Promise<AgentMessage[]>{
    const channel = this.channels.toArray().find(c => c.name === channelName);
    if (!channel) throw new Error('Channel not found');
    
    // Try to get messages by UUID first (new system)
    let arr = this.messages.get(channel.uuid);
    
    // If no messages found by UUID, try the old channel name system (for backward compatibility)
    if (!arr || arr.length === 0) {
      const oldArr = this.messages.get(channelName);
      if (oldArr && oldArr.length > 0) {
        // Migrate old messages to new UUID-based system
        const messages = oldArr.toArray();
        const newArr = new Y.Array<AgentMessage>();
        newArr.insert(0, messages);
        this.messages.set(channel.uuid, newArr);
        
        // Remove old messages (optional, for cleanup)
        this.messages.delete(channelName);
        
        arr = newArr;
      }
    }
    
    if (!arr) {
      // Create empty array if no messages exist
      arr = new Y.Array<AgentMessage>();
      this.messages.set(channel.uuid, arr);
    }
    
    return arr.toArray();
  }

  /**
   * Delete an agent channel and all its messages.
   * @param channelName Name of the channel to delete
   */
  public async deleteAgentChannel(channelName: string): Promise<void> {
    const channelIndex = this.channels.toArray().findIndex((ch) => ch.name === channelName);
    if (channelIndex === -1) {
      throw new Error('Channel not found');
    }

    const channel = this.channels.toArray()[channelIndex];

    // Perform all deletions in a single Y.js transaction for atomicity
    this.doc.transact(() => {
      // Remove the channel from the list
      this.channels.delete(channelIndex);
      
      // Remove the message history using UUID
      this.messages.delete(channel.uuid);
    });

    console.log(`Deleted agent channel: ${channelName}`);
  }

  /**
   * Send a message to a channel.
   * if the message role is user it will be forwarded to the underlying agent via {@link invokeAgent}
   * Reply will be appended to the same channel once received.
   * @param channelName Name of the channel to send to
   * @param message The message to send. 'uuid' and 'ts' will be auto set.
   */
  public async sendMessage(channelName: string, message: Omit<AgentMessage, 'uuid' | 'ts'> & { ts?: number }): Promise<void> {
    // Find the channel by name
    const chan = this.channels.toArray().find((c) => c.name === channelName);
    if (!chan) throw new Error('Channel not found');

    // build the message object with auto-generated uuid and timestamp
    const msg: AgentMessage = {
      uuid: nanoid(),
      ts: message.ts ?? Date.now(),
      user: message.user,
      message: message.message,
      role: message.role,
    };
    (await this.getMsgArray(chan.uuid)).push([msg]);
    //If this is a user message, forward it to the agent asynchronously
    if (msg.role === 'user'){
      this.invokeAgent(chan.agent, msg, chan.uuid).catch((e) => {
        console.error('Agent invocation failed', e);
      });
    }

  }

  /**
   * Internal helper to perform an A2A invocation against the given agent.
   * This method uses a simple HTTP POST to an '/invoke' endpoint;
   * if the agent implements a different contract adjust this accordingly.
   * replies will be recorded in the channel as Agent messages
   *
   * @param agent The agent card used to determine the endpoint
   * @param userMsg The user message that triggered the invocation
   * @param channelUuid UUID of the channel where the reply should be stored
   */
  private async invokeAgent(agent: AgentCard, userMsg: AgentMessage, channelUuid: string): Promise<void>{
    // Get last 20 messages as context (excluding the current user message)
    const msgArray = await this.getMsgArray(channelUuid);
    const allMessages = msgArray.toArray();
    
    // Filter out system messages (channel creation messages) and get context
    const filteredMessages = allMessages.filter(msg => {
      // Skip system messages that contain "agent channel was created"
      return !(msg.user === 'ownly-bot' && msg.message.includes('agent channel was created'));
    });
    
    // Get last 20 messages (excluding the just-added current message)
    const contextMessages = filteredMessages.slice(-21, -1).slice(-20);
    
    // Check if agent uses JSON-RPC protocol
    // requires auto-detection update later
    const useJsonRpc = agent.preferredTransport === 'JSONRPC' ||
                       (agent as any).preferredTransport === 'JSONRPC' ||
                       agent.protocolVersion === '0.3.0' ||  // Our agent card at llama server currently has this
                       (agent as any).protocolVersion === '0.3.0';

    console.log('Agent card properties:', Object.keys(agent));
    console.log('preferredTransport:', agent.preferredTransport || (agent as any).preferredTransport);
    console.log('protocolVersion:', agent.protocolVersion || (agent as any).protocolVersion);
    console.log('Will use JSON-RPC:', useJsonRpc);
    console.log('Total messages in channel:', allMessages.length);
    console.log('Context messages count:', contextMessages.length);
    console.log('Context messages:', contextMessages.map(m => `${m.role}: ${m.message}`));

    let payload: any;
    let endpoint: string;

    if (useJsonRpc) {
      // Check if agent supports structured history
      const supportsHistory = (agent as any).supportsHistory === true || (agent as any).history === true;
      
      const baseParams: any = {
        message: {
          role: "user",
          messageId: userMsg.uuid,
          parts: [
            { text: userMsg.message }
          ]
        }
      };
      
      // Add structured history only if agent supports it
      if (supportsHistory && contextMessages.length > 0) {
        const messageHistory = contextMessages.map(msg => ({
          role: msg.role,
          content: msg.message
        }));
        baseParams.history = messageHistory;
      } else if (contextMessages.length > 0) {
        // Fallback: include history in message text for better compatibility
        const historyText = contextMessages
          .slice(-10)  // Last 10 messages to avoid token limits
          .map(msg => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.message}`)
          .join('\n');
        
        baseParams.message.parts[0].text = `Previous conversation:\n${historyText}\n\nHuman: ${userMsg.message}\n\nPlease respond as the character established in our conversation:`;
      }
      
      payload = {
        jsonrpc: "2.0",
        id: userMsg.uuid,
        method: "message/send",
        params: baseParams
      };
      endpoint = agent.url.replace(/\/+$/, ''); // Use base URL for JSON-RPC
    } else {
      // Check if agent supports structured history for REST
      const supportsHistory = (agent as any).supportsHistory === true || (agent as any).history === true;
      
      const basePayload: any = {
        input: { text: userMsg.message }
      };
      
      // Add structured history only if agent supports it
      if (supportsHistory && contextMessages.length > 0) {
        const messageHistory = contextMessages.map(msg => ({
          role: msg.role,
          content: msg.message
        }));
        basePayload.history = messageHistory;
      } else if (contextMessages.length > 0) {
        // Fallback: include history in message text
        const historyText = contextMessages
          .slice(-10)  // Last 10 messages to avoid token limits
          .map(msg => `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${msg.message}`)
          .join('\n');
        
        basePayload.input.text = `Previous conversation:\n${historyText}\n\nHuman: ${userMsg.message}\n\nPlease respond as the character established in our conversation:`;
      }
      
      payload = basePayload;
      endpoint = `${agent.url.replace(/\/+$/, '')}/invoke`;
    }

    let responseText: string | undefined;

    try {
      console.log(`Invoking agent at: ${endpoint}`);
      console.log('Protocol:', useJsonRpc ? 'JSON-RPC' : 'REST');
      console.log('Payload:', JSON.stringify(payload, null, 2));

      const res = await fetch(endpoint, {
        method: 'POST',
        mode: 'cors',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      console.log('Response status:', res.status);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      // Parse response based on protocol
      const data = await res.json();
      console.log('Response data:', data);

      if (useJsonRpc) {
        // Handle JSON-RPC response
        if (data.error) {
          throw new Error(`JSON-RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
        }

        const result = data.result;
        if (typeof result === 'string') {
          responseText = result;
        } else if (result && typeof result.content === 'string') {
          responseText = result.content;
        } else if (result && typeof result.text === 'string') {
          responseText = result.text;
        } else if (result && typeof result.message === 'string') {
          responseText = result.message;
        } else if (result && result.parts && Array.isArray(result.parts) && result.parts[0]?.text) {
          responseText = result.parts[0].text;
        } else {
          responseText = JSON.stringify(result || data);
        }
      } else {
        // Handle REST/A2A response
        if (typeof data === 'string') {
          responseText = data;
        } else if (typeof (data as any).content === 'string') {
          responseText = (data as any).content;
        } else if (typeof (data as any).text === 'string') {
          responseText = (data as any).text;
        } else if (typeof (data as any).message === 'string') {
          responseText = (data as any).message;
        } else if (typeof (data as any).response === 'string') {
          responseText = (data as any).response;
        } else {
          responseText = JSON.stringify(data);
        }
      }

    } catch (e) {
      console.error('Agent invocation error:', e);

      if (e instanceof TypeError && e.message.includes('Failed to fetch') ) {
        responseText = `CORS Error: Cannot connect to agent at ${agent.url}. The agent server needs to allow cross-origin requests from your domain. Please contact the agent provider to add CORS headers.`;
      } else if (e instanceof Error) {
        responseText = `Error from agent: ${e.message}`;
      } else {
        responseText = `Unknown error: ${e}`;
      }
    }
    // Append the agent's reply to the channel
    const reply: AgentMessage = {
      uuid: nanoid(),
      user: agent.name,
      ts: Date.now(),
      message: responseText ??  '',
      role: 'agent',
    };
    (await this.getMsgArray(channelUuid)).push([reply]);
  }

}


