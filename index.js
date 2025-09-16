const { Telegraf, Markup } = require('telegraf');
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs').promises;

require('dotenv').config();

class SolanaWalletMonitor {
    constructor() {
        this.bot = new Telegraf(process.env.BOT_TOKEN);
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        // Single wallet from environment
        this.monitoredWallet = process.env.WALLET_ADDRESS;
        
        // Storage for user settings
        this.userSettings = new Map();
        this.subscribedUsers = new Set();
        this.lastSignature = null;
        this.monitoringInterval = null;
        
        this.setupCommands();
        this.loadUserData();
        
        // Set polling interval (check every 30 seconds)
        this.POLL_INTERVAL = 20000;
        
        // Start monitoring immediately if wallet is configured
        if (this.monitoredWallet) {
            this.startMonitoring();
        }
    }

    async loadUserData() {
        try {
            const data = await fs.readFile('user_data.json', 'utf8');
            const parsed = JSON.parse(data);
            this.userSettings = new Map(parsed.userSettings || []);
            this.subscribedUsers = new Set(parsed.subscribedUsers || []);
            this.lastSignature = parsed.lastSignature || null;
            
            console.log(`Loaded ${this.subscribedUsers.size} subscribed users`);
        } catch (error) {
            console.log('No existing user data found, starting fresh');
        }
    }

    async saveUserData() {
        const data = {
            userSettings: Array.from(this.userSettings.entries()),
            subscribedUsers: Array.from(this.subscribedUsers),
            lastSignature: this.lastSignature
        };
        await fs.writeFile('user_data.json', JSON.stringify(data, null, 2));
    }

    setupCommands() {
        // Start command - subscribes user to notifications
        this.bot.start(async (ctx) => {
            const chatId = ctx.chat.id;
            this.subscribedUsers.add(chatId);
            await this.saveUserData();
            
            const welcomeMessage = `
🚀 *Arbitka Revshare Tracker*

You will receive notifications on RevShare: PlatformFee transactions\\

*Monitored Wallet:*
\`${this.monitoredWallet || 'Not configured'}\`

*Available Commands:*
/settings \\ Manage filters \\(min SOL amount, blacklist\\)
/unsubscribe \\ Stop receiving notifications
/help \\ Show this message again

You will receive notifications on RevShare: PlatformFee transactions \\
            `;
            ctx.replyWithMarkdownV2(welcomeMessage);
        });

        // Help command
        this.bot.help((ctx) => {
            ctx.replyWithMarkdownV2(`
*Commands:*
/start \\- Subscribe to wallet notifications
/settings \\- Configure filters
/unsubscribe \\- Unsubscribe from notifications
/help \\- Show help

*Monitored wallet:*
\`${this.monitoredWallet || 'Not configured'}\`

*Settings:*
• Set minimum amount SOL
• Manage blacklist
            `);
        });

        // Settings command
        this.bot.command('settings', (ctx) => this.showSettings(ctx));

        // Unsubscribe command
        this.bot.command('unsubscribe', async (ctx) => {
            const chatId = ctx.chat.id;
            this.subscribedUsers.delete(chatId);
            this.userSettings.delete(chatId);
            await this.saveUserData();
            
            ctx.reply('✅ You have been unsubscribed from wallet notifications.');
        });

        // Handle callback queries for settings
        this.bot.action('set_min_amount', (ctx) => {
            ctx.answerCbQuery();
            ctx.reply('💰 Please enter the minimum SOL amount (e.g., 0.1):');
            
            // Set up one-time listener for the next message
            this.bot.hears(/^\d*\.?\d+$/, (msgCtx) => {
                if (msgCtx.chat.id === ctx.chat.id) {
                    const amount = parseFloat(msgCtx.message.text);
                    const settings = this.userSettings.get(ctx.chat.id) || { minAmount: 0, blacklist: [] };
                    settings.minAmount = amount;
                    this.userSettings.set(ctx.chat.id, settings);
                    this.saveUserData();
                    msgCtx.reply(`✅ Minimum amount set to ${amount} SOL`);
                }
            });
        });

        this.bot.action('manage_blacklist', (ctx) => {
            ctx.answerCbQuery();
            const chatId = ctx.chat.id;
            const settings = this.userSettings.get(chatId) || { minAmount: 0, blacklist: [] };
            
            if (settings.blacklist.length === 0) {
                ctx.reply('🚫 Your blacklist is empty.\nSend me a wallet address to add to blacklist:');
            } else {
                const blacklistText = settings.blacklist.map((addr, i) => `${i + 1}. \`${addr}\``).join('\n');
                ctx.replyWithMarkdown(`🚫 *Current Blacklist:*\n\n${blacklistText}\n\nSend me a new address to add, or type "remove <number>" to remove.`);
            }
        });

        this.bot.action('open_settings', (ctx) => this.showSettings(ctx));

        // Handle blacklist management
        this.bot.hears(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, (ctx) => {
            const chatId = ctx.chat.id;
            const address = ctx.message.text;
            
            if (!this.subscribedUsers.has(chatId)) {
                return;
            }
            
            if (this.isValidSolanaAddress(address)) {
                const settings = this.userSettings.get(chatId) || { minAmount: 0, blacklist: [] };
                
                if (!settings.blacklist.includes(address)) {
                    settings.blacklist.push(address);
                    this.userSettings.set(chatId, settings);
                    this.saveUserData();
                    ctx.reply(`✅ Added address to blacklist: \`${address}\``, { parse_mode: 'Markdown' });
                } else {
                    ctx.reply('📍 This address is already in your blacklist.');
                }
            }
        });

        // Handle remove from blacklist
        this.bot.hears(/^remove (\d+)$/i, (ctx) => {
            const chatId = ctx.chat.id;
            
            if (!this.subscribedUsers.has(chatId)) {
                return;
            }
            
            const index = parseInt(ctx.match[1]) - 1;
            const settings = this.userSettings.get(chatId) || { minAmount: 0, blacklist: [] };
            
            if (index >= 0 && index < settings.blacklist.length) {
                const removed = settings.blacklist.splice(index, 1)[0];
                this.userSettings.set(chatId, settings);
                this.saveUserData();
                ctx.reply(`✅ Removed from blacklist: \`${removed}\``, { parse_mode: 'Markdown' });
            } else {
                ctx.reply('❌ Invalid number. Please check your blacklist and try again.');
            }
        });
    }

    isValidSolanaAddress(address) {
        try {
            new PublicKey(address);
            return address.length >= 32 && address.length <= 44;
        } catch {
            return false;
        }
    }

    // общий метод для вызова меню настроек
    async showSettings(ctx) {
        const chatId = ctx.chat.id;

        if (!this.subscribedUsers.has(chatId)) {
            return ctx.reply('❌ You need to /start first to subscribe to notifications.');
        }

        const settings = this.userSettings.get(chatId) || {
            minAmount: 0,
            blacklist: []
        };

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💰 Set min amount SOL', 'set_min_amount')],
            [Markup.button.callback('🚫 Manage blacklist', 'manage_blacklist')]
        ]);

        await ctx.replyWithMarkdownV2(`
    ⚙️ *Current Settings:*

    💰 Minimum SOL Amount: ${settings.minAmount}
    🚫 Blacklisted Addresses: ${settings.blacklist.length}
        `, keyboard);
    }


    async startMonitoring() {
        if (!this.monitoredWallet) {
            console.error('❌ WALLET_ADDRESS not configured in environment variables');
            return;
        }

        if (!this.isValidSolanaAddress(this.monitoredWallet)) {
            console.error('❌ Invalid wallet address in WALLET_ADDRESS environment variable');
            return;
        }

        console.log(`🔍 Starting monitoring for wallet: ${this.monitoredWallet}`);
        
        try {
            const publicKey = new PublicKey(this.monitoredWallet);
            
            // Get initial signatures to establish baseline if not already set
            if (!this.lastSignature) {
                const initialSignatures = await this.connection.getSignaturesForAddress(publicKey, { limit: 1 });
                this.lastSignature = initialSignatures.length > 0 ? initialSignatures[0].signature : null;
                await this.saveUserData();
            }
            
            console.log(`📊 Baseline signature: ${this.lastSignature || 'No transactions'}`);
            
            // Start polling
            this.monitoringInterval = setInterval(async () => {
                await this.checkForNewTransactions();
            }, this.POLL_INTERVAL);
            
            console.log(`⏱️  Polling every ${this.POLL_INTERVAL / 1000} seconds`);
            
        } catch (error) {
            console.error(`Error starting monitoring:`, error);
        }
    }

    async checkForNewTransactions() {
        try {
            const publicKey = new PublicKey(this.monitoredWallet);
            const signatures = await this.connection.getSignaturesForAddress(publicKey, { limit: 10 });
            
            if (signatures.length === 0) {
                return;
            }

            const newSignatures = [];
            
            // Find new signatures
            for (const sig of signatures) {
                if (sig.signature === this.lastSignature) {
                    break;
                }
                newSignatures.push(sig);
            }

            if (newSignatures.length > 0) {
                console.log(`🆕 Found ${newSignatures.length} new transactions`);
                
                // Update last known signature
                this.lastSignature = signatures[0].signature;
                await this.saveUserData();
                
                // Process new transactions (in reverse order, oldest first)
                for (const signature of newSignatures.reverse()) {
                    await this.processTransaction(signature);
                    
                    // Small delay between processing transactions
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
        } catch (error) {
            console.error(`Error checking transactions:`, error);
            
            // If it's a connection error, try to continue monitoring
            if (error.message.includes('fetch')) {
                console.log('Connection error, will retry next interval...');
            }
        }
    }

    async processTransaction(signatureInfo) {
        try {
            const transaction = await this.connection.getTransaction(signatureInfo.signature, {
                maxSupportedTransactionVersion: 0
            });

            if (!transaction || !transaction.meta) {
                return;
            }

            console.log(`📋 Processing transaction ${signatureInfo.signature}`);
            
            // Parse SOL transfers
            const solTransfers = this.parseSOLTransfers(transaction, this.monitoredWallet);
            
            for (const transfer of solTransfers) {
                // Send notification to all subscribed users
                await this.notifyAllUsers(transfer, signatureInfo);
            }
            
        } catch (error) {
            console.error('Error processing transaction:', error);
        }
    }

    parseSOLTransfers(transaction, targetWallet) {
        const transfers = [];
        
        try {
            const preBalances = transaction.meta.preBalances;
            const postBalances = transaction.meta.postBalances;
            const accountKeys = transaction.transaction.message.accountKeys;

            // Find target wallet index
            let targetIndex = -1;
            for (let i = 0; i < accountKeys.length; i++) {
                if (accountKeys[i].toString() === targetWallet) {
                    targetIndex = i;
                    break;
                }
            }

            if (targetIndex === -1) {
                return transfers;
            }

            // Calculate balance change for target wallet
            const balanceChange = (postBalances[targetIndex] - preBalances[targetIndex]) / 1e9; // Convert lamports to SOL
            
            if (balanceChange > 0) {
                // Incoming transfer - find sender
                for (let i = 0; i < accountKeys.length; i++) {
                    if (i !== targetIndex) {
                        const senderBalanceChange = (preBalances[i] - postBalances[i]) / 1e9;
                        // Allow for some variance due to fees
                        if (Math.abs(senderBalanceChange - balanceChange) < 0.001) {
                            transfers.push({
                                from: accountKeys[i].toString(),
                                to: targetWallet,
                                amount: balanceChange,
                                type: 'incoming'
                            });
                            break;
                        }
                    }
                }
            } else if (balanceChange < 0) {
                // Outgoing transfer - find receiver
                for (let i = 0; i < accountKeys.length; i++) {
                    if (i !== targetIndex) {
                        const receiverBalanceChange = (postBalances[i] - preBalances[i]) / 1e9;
                        if (receiverBalanceChange > 0 && Math.abs(receiverBalanceChange + balanceChange) < 0.001) {
                            transfers.push({
                                from: targetWallet,
                                to: accountKeys[i].toString(),
                                amount: Math.abs(balanceChange),
                                type: 'outgoing'
                            });
                            break;
                        }
                    }
                }
            }
            
        } catch (error) {
            console.error('Error parsing SOL transfers:', error);
        }
        
        return transfers;
    }

    async notifyAllUsers(transfer, signatureInfo) {
        const direction = transfer.type === 'incoming' ? '📥' : '📤';
        const fromTo = transfer.type === 'incoming' ? transfer.from : transfer.to;
        const verb = transfer.type === 'incoming' ? 'Received' : 'Sent';

        const message = `
    ${direction} *New Transaction Detected!*

    💰 *${verb}:* ${transfer.amount.toFixed(8)} SOL
    👤 *${transfer.type === 'incoming' ? 'From' : 'To'}:* \`${fromTo}\`
    🕐 *Time:* ${new Date(signatureInfo.blockTime * 1000).toLocaleString()}
    🔗 *Signature:* \`${signatureInfo.signature}\`
        `;

        // Кнопки
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🔗 View TX", url: `https://solscan.io/tx/${signatureInfo.signature}` },
                        { text: "👤 View Sender", url: `https://solscan.io/account/${transfer.from}` }
                    ],
                    [
                        { text: "⚙️ Settings", callback_data: "open_settings" }
                    ]
                ]
            }
        };

        // Отправляем каждому пользователю
        for (const chatId of this.subscribedUsers) {
            try {
                const settings = this.userSettings.get(chatId) || { minAmount: 0, blacklist: [] };

                // Фильтры
                if (transfer.amount < settings.minAmount) {
                    console.log(`💰 Transfer ${transfer.amount} SOL below minimum ${settings.minAmount} SOL for user ${chatId}`);
                    continue;
                }
                if (settings.blacklist.includes(transfer.from)) {
                    console.log(`🚫 Transfer from blacklisted address for user ${chatId}: ${transfer.from}`);
                    continue;
                }

                await this.bot.telegram.sendMessage(chatId, message, { 
                    parse_mode: "Markdown",
                    disable_web_page_preview: true,
                    ...keyboard
                });

                console.log(`✅ Notification sent to user ${chatId} for ${transfer.amount} SOL transfer`);

            } catch (error) {
                console.error(`Error sending notification to user ${chatId}:`, error);

                // Если пользователь заблокировал бота — удаляем его
                if (error.response && error.response.error_code === 403) {
                    console.log(`🚫 User ${chatId} blocked the bot, removing from subscribers`);
                    this.subscribedUsers.delete(chatId);
                    this.userSettings.delete(chatId);
                    await this.saveUserData();
                }
            }
        }
    }


    async start() {
        // Error handling
        this.bot.catch((err, ctx) => {
            console.error('Bot error:', err);
            if (ctx) {
                ctx.reply('❌ An error occurred. Please try again.').catch(console.error);
            }
        });

        // Graceful shutdown
        const shutdown = async (signal) => {
            console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);
            
            // Clear monitoring interval
            if (this.monitoringInterval) {
                clearInterval(this.monitoringInterval);
            }
            
            // Save data
            await this.saveUserData();
            
            // Stop bot
            this.bot.stop(signal);
            process.exit(0);
        };

        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));

        await this.bot.launch();
        console.log('🚀 Solana Wallet Monitor Bot is running!');
        console.log(`📊 Monitoring wallet: ${this.monitoredWallet}`);
        console.log(`👥 ${this.subscribedUsers.size} subscribed users`);
    }
}

// Environment validation
function validateEnvironment() {
    if (!process.env.BOT_TOKEN) {
        console.error('❌ BOT_TOKEN environment variable is required');
        process.exit(1);
    }
    
    if (!process.env.WALLET_ADDRESS) {
        console.error('❌ WALLET_ADDRESS environment variable is required');
        process.exit(1);
    }
}

// Start the bot
async function main() {
    try {
        validateEnvironment();
        const monitor = new SolanaWalletMonitor();
        await monitor.start();
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = SolanaWalletMonitor;