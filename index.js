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
        
        this.fixedSolAmounts = [0.1, 0.15, 0.3];
        this.subscribedUsers = new Set();
        this.lastSignature = null;
        this.monitoringInterval = null;
        
        this.setupCommands();
        this.loadUserData();
        
        // Set polling interval (check every 30 seconds)
        this.POLL_INTERVAL = 10000;
        
        // Start monitoring immediately if wallet is configured
        if (this.monitoredWallet) {
            this.startMonitoring();
        }
    }

    async loadUserData() {
        try {
            const data = await fs.readFile('user_data.json', 'utf8');
            const parsed = JSON.parse(data);
            this.subscribedUsers = new Set(parsed.subscribedUsers || []);
            this.lastSignature = parsed.lastSignature || null;
            
            console.log(`Loaded ${this.subscribedUsers.size} subscribed users`);
        } catch (error) {
            console.log('No existing user data found, starting fresh');
        }
    }

    async saveUserData() {
        const data = {
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
/unsubscribe \\ Stop receiving notifications
/help \\ Show this message again
            `;
            ctx.replyWithMarkdownV2(welcomeMessage);
        });

        // Help command
        this.bot.help((ctx) => {
            ctx.replyWithMarkdownV2(`
*Commands:*
/start \\- Subscribe to wallet notifications
/unsubscribe \\- Unsubscribe from notifications
/help \\- Show help

*Monitored wallet:*
\`${this.monitoredWallet || 'Not configured'}\``);
        });


        // Unsubscribe command
        this.bot.command('unsubscribe', async (ctx) => {
            const chatId = ctx.chat.id;
            this.subscribedUsers.delete(chatId);
            await this.saveUserData();
            
            ctx.reply('✅ You have been unsubscribed from wallet notifications.');
        });
    }

    async startMonitoring() {
        if (!this.monitoredWallet) {
            console.error('❌ WALLET_ADDRESS not configured in environment variables');
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
                
                // Process new transactions (in reverse order, oldest first)
                for (const signature of newSignatures.reverse()) {
                    await this.processTransaction(signature);
                    
                    this.lastSignature = signature.signature;
                    await this.saveUserData();
                    
                    // Longer delay between processing transactions to prevent overlap
                    await new Promise(resolve => setTimeout(resolve, 2000));
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
              console.log(transfer.amount)
              if (this.fixedSolAmounts.includes(transfer.amount)) {
                // Send notification to all subscribed users
                console.log(true);
                await this.notifyAllUsers(transfer, signatureInfo);
              }
              else {
                console.log('📋 Transaction analyzed: spam transaction / rewards fee transactions.')
              }
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
                    ]
                ]
            }
        };

        // Отправляем каждому пользователю
        for (const chatId of this.subscribedUsers) {
            try {
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