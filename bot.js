// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os'); // Added for system monitoring

const BOT_TOKEN = process.env.TOKEN;

// Import database modules
const db = require('./database/mongo');
const serverModule = require('./database/modules/server');
const playerModule = require('./database/modules/player');
const gateModule = require('./database/modules/gate');
const giveawayModule = require('./database/modules/giveaway');
const commandLogsModule = require('./database/modules/commandLogs');
const wishlistModule = require('./database/modules/wishlist');

const client = new Client({
    shards: 'auto', // Enable sharding mode
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.commands = new Collection();
client.slashCommands = new Collection();
client.config = require('./config.json');

// System monitoring function
function monitorSystem() {
    // RAM Usage
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsagePercent = ((usedMemory / totalMemory) * 100).toFixed(2);

    // Process Memory Usage
    const processMemoryUsage = process.memoryUsage();
    const heapUsed = (processMemoryUsage.heapUsed / 1024 / 1024).toFixed(2);
    const heapTotal = (processMemoryUsage.heapTotal / 1024 / 1024).toFixed(2);

    // Network Interfaces
    const networkInterfaces = os.networkInterfaces();
    const networkStats = Object.entries(networkInterfaces)
        .map(([name, interfaces]) => {
            return interfaces
                .filter(iface => !iface.internal) // Filter out loopback interface
                .map(iface => ({
                    name,
                    address: iface.address,
                    family: iface.family,
                    mac: iface.mac
                }));
        })
        .flat();

    console.log('\n=== System Monitor ===');
    console.log(`RAM Usage: ${memoryUsagePercent}% (${(usedMemory / 1024 / 1024 / 1024).toFixed(2)}GB / ${(totalMemory / 1024 / 1024 / 1024).toFixed(2)}GB)`);
    console.log(`Heap Usage: ${heapUsed}MB / ${heapTotal}MB`);
    console.log('\nNetwork Interfaces:');
    networkStats.forEach(iface => {
        console.log(`${iface.name}: ${iface.address} (${iface.family})`);
    });
    console.log('===================\n');
}

// Initialize database connection with retry logic and shard awareness
async function initializeDatabase(retries = 5, delay = 5000) {
    const shardId = client.shard?.ids[0] ?? 'Unsharded';
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { 
                mServerDB, 
                mUserDB, 
                mServerSettingsDB, 
                mGateDB, 
                mGateServerDB,
                mCommandLogsDB,
                mGiveawayDB,
                mCardWishlistDB,
                mUserWishlistDB
            } = await db.connectDB();

            // Make database collections and methods accessible throughout the bot
            client.database = {
                // Spread database methods first
                ...db,
                
                // Include specific database module methods
                createServer: serverModule.createServer,
                createServerSettings: serverModule.createServerSettings,
                toggleRegister: serverModule.toggleRegister,
                toggleAllowRolePing: serverModule.toggleAllowRolePing,
                getServerData: serverModule.getServerData,
                getServerSettings: serverModule.getServerSettings,
                addServerClaim: serverModule.addServerClaim,

                // Player module methods
                createPlayer: playerModule.createPlayer,
                getPlayer: playerModule.getPlayer,
                updatePlayer: playerModule.updatePlayer,

                // Gate module methods
                ...gateModule,

                // Giveaway module methods
                ...giveawayModule,

                // Command logs module methods
                logCommand: commandLogsModule.logCommand,

                // Wishlist module methods
                ...wishlistModule,

                // Set specific collections so they don't get overwritten
                servers: mServerDB,
                users: mUserDB,
                serverSettings: mServerSettingsDB,
                mGateDB,
                mGateServerDB,
                mCommandLogsDB,
                mGiveawayDB,
                mCardWishlistDB,
                mUserWishlistDB
            };
            
            console.log(`[Shard ${shardId}] Database initialization successful`);
            return true;
        } catch (err) {
            console.error(`[Shard ${shardId}] Database initialization attempt ${attempt} failed:`, err);
            if (attempt === retries) {
                console.error(`[Shard ${shardId}] All database connection attempts failed`);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Load Slash Commands
const slashCommandsPath = path.join(__dirname, 'slashCommands');
const slashCommandFiles = fs.readdirSync(slashCommandsPath).filter(file => file.endsWith('.js'));

for (const file of slashCommandFiles) {
    const command = require(path.join(slashCommandsPath, file));
    client.slashCommands.set(command.data.name, command);
}

// Event Handler with improved error handling and shard awareness
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
        client.once(event.name, async (...args) => {
            try {
                if (!args[0].guild) return;
                if (!args[0].guild.id==process.env.GUILD_ID) return;
                const serverExist = await client.database.getServerSettings(args[0].guild.id);
                if(!serverExist) await client.database.createServerSettings(args[0].guild.id);
                await event.execute(...args, { 
                    database: client.database, 
                    config: client.config,
                    shardId: client.shard?.ids[0] 
                });
            } catch (error) {
                console.error(`[Shard ${client.shard?.ids[0]}] Error in event ${event.name}:`, error);
            }
        });
    } else {
        client.on(event.name, async (...args) => {
            try {
                if (event.name === 'messageCreate') {
                    await event.execute(...args, { 
                        database: client.database, 
                        config: client.config,
                        shardId: client.shard?.ids[0]
                    });
                } else {
                    if (!args[0].guild) return;
                    if (!args[0].guild.id==process.env.GUILD_ID) return;
                    const serverExist = await client.database.getServerSettings(args[0].guild.id);
                    if(!serverExist) await client.database.createServerSettings(args[0].guild.id);
                    await event.execute(...args, { 
                        database: client.database, 
                        config: client.config,
                        shardId: client.shard?.ids[0]
                    });
                }
            } catch (error) {
                console.error(`[Shard ${client.shard?.ids[0]}] Error in event ${event.name}:`, error);
            }
        });
    }
}

// Discord client error handling with shard awareness
client.on('error', error => {
    console.error(`[Shard ${client.shard?.ids[0]}] Discord client error:`, error);
});

client.on('disconnect', () => {
    console.log(`[Shard ${client.shard?.ids[0]}] Bot disconnected from Discord`);
});

client.on('reconnecting', () => {
    console.log(`[Shard ${client.shard?.ids[0]}] Bot reconnecting to Discord`);
});

client.on('warn', info => {
    console.log(`[Shard ${client.shard?.ids[0]}] Warning:`, info);
});

// Initialize database and start bot
async function startBot() {
    try {
        const dbInitialized = await initializeDatabase();
        if (!dbInitialized) {
            console.error(`[Shard ${client.shard?.ids[0]}] Failed to initialize database. Exiting...`);
            process.exit(1);
        }

        // Start system monitoring
        setInterval(monitorSystem, 60000); // Monitor every minute
        monitorSystem(); // Initial monitoring call

        await client.login(BOT_TOKEN);
        console.log(`[Shard ${client.shard?.ids[0]}] Bot successfully logged in to Discord`);
    } catch (error) {
        console.error(`[Shard ${client.shard?.ids[0]}] Error starting bot:`, error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log(`[Shard ${client.shard?.ids[0]}] Received SIGINT. Cleaning up...`);
    try {
        await client.destroy();
        process.exit(0);
    } catch (error) {
        console.error(`[Shard ${client.shard?.ids[0]}] Error during cleanup:`, error);
        process.exit(1);
    }
});

process.on('unhandledRejection', error => {
    console.error(`[Shard ${client.shard?.ids[0]}] Unhandled promise rejection:`, error);
});

startBot();
